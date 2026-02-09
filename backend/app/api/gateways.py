"""Gateway CRUD and template synchronization endpoints."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlmodel import col

from app.api.deps import require_org_admin
from app.core.agent_tokens import generate_agent_token, hash_agent_token
from app.core.auth import AuthContext, get_auth_context
from app.core.time import utcnow
from app.db import crud
from app.db.pagination import paginate
from app.db.session import get_session
from app.integrations.openclaw_gateway import GatewayConfig as GatewayClientConfig
from app.integrations.openclaw_gateway import (
    OpenClawGatewayError,
    ensure_session,
    openclaw_call,
    send_message,
)
from app.models.activity_events import ActivityEvent
from app.models.agents import Agent
from app.models.approvals import Approval
from app.models.gateways import Gateway
from app.models.tasks import Task
from app.schemas.common import OkResponse
from app.schemas.gateways import (
    GatewayCreate,
    GatewayRead,
    GatewayTemplatesSyncResult,
    GatewayUpdate,
)
from app.schemas.pagination import DefaultLimitOffsetPage
from app.services.agent_provisioning import (
    DEFAULT_HEARTBEAT_CONFIG,
    MainAgentProvisionRequest,
    ProvisionOptions,
    provision_main_agent,
)
from app.services.gateway_agents import (
    gateway_agent_session_key,
    gateway_openclaw_agent_id,
)
from app.services.template_sync import GatewayTemplateSyncOptions
from app.services.template_sync import sync_gateway_templates as sync_gateway_templates_service

if TYPE_CHECKING:
    from fastapi_pagination.limit_offset import LimitOffsetPage
    from sqlmodel.ext.asyncio.session import AsyncSession

    from app.models.users import User
    from app.services.organizations import OrganizationContext

router = APIRouter(prefix="/gateways", tags=["gateways"])
SESSION_DEP = Depends(get_session)
AUTH_DEP = Depends(get_auth_context)
ORG_ADMIN_DEP = Depends(require_org_admin)
INCLUDE_MAIN_QUERY = Query(default=True)
RESET_SESSIONS_QUERY = Query(default=False)
ROTATE_TOKENS_QUERY = Query(default=False)
FORCE_BOOTSTRAP_QUERY = Query(default=False)
BOARD_ID_QUERY = Query(default=None)
_RUNTIME_TYPE_REFERENCES = (UUID,)
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _TemplateSyncQuery:
    include_main: bool
    reset_sessions: bool
    rotate_tokens: bool
    force_bootstrap: bool
    board_id: UUID | None


def _template_sync_query(
    *,
    include_main: bool = INCLUDE_MAIN_QUERY,
    reset_sessions: bool = RESET_SESSIONS_QUERY,
    rotate_tokens: bool = ROTATE_TOKENS_QUERY,
    force_bootstrap: bool = FORCE_BOOTSTRAP_QUERY,
    board_id: UUID | None = BOARD_ID_QUERY,
) -> _TemplateSyncQuery:
    return _TemplateSyncQuery(
        include_main=include_main,
        reset_sessions=reset_sessions,
        rotate_tokens=rotate_tokens,
        force_bootstrap=force_bootstrap,
        board_id=board_id,
    )


SYNC_QUERY_DEP = Depends(_template_sync_query)


def _main_agent_name(gateway: Gateway) -> str:
    return f"{gateway.name} Gateway Agent"


def _gateway_identity_profile() -> dict[str, str]:
    return {
        "role": "Gateway Agent",
        "communication_style": "direct, concise, practical",
        "emoji": ":compass:",
    }


async def _require_gateway(
    session: AsyncSession,
    *,
    gateway_id: UUID,
    organization_id: UUID,
) -> Gateway:
    gateway = (
        await Gateway.objects.by_id(gateway_id)
        .filter(col(Gateway.organization_id) == organization_id)
        .first(session)
    )
    if gateway is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Gateway not found",
        )
    return gateway


async def _find_main_agent(
    session: AsyncSession,
    gateway: Gateway,
) -> Agent | None:
    return (
        await Agent.objects.filter_by(gateway_id=gateway.id)
        .filter(col(Agent.board_id).is_(None))
        .first(session)
    )


async def _upsert_main_agent_record(
    session: AsyncSession,
    gateway: Gateway,
) -> tuple[Agent, bool]:
    changed = False
    session_key = gateway_agent_session_key(gateway)
    agent = await _find_main_agent(session, gateway)
    if agent is None:
        agent = Agent(
            name=_main_agent_name(gateway),
            status="provisioning",
            board_id=None,
            gateway_id=gateway.id,
            is_board_lead=False,
            openclaw_session_id=session_key,
            heartbeat_config=DEFAULT_HEARTBEAT_CONFIG.copy(),
            identity_profile=_gateway_identity_profile(),
        )
        session.add(agent)
        changed = True
    if agent.board_id is not None:
        agent.board_id = None
        changed = True
    if agent.gateway_id != gateway.id:
        agent.gateway_id = gateway.id
        changed = True
    if agent.is_board_lead:
        agent.is_board_lead = False
        changed = True
    if agent.name != _main_agent_name(gateway):
        agent.name = _main_agent_name(gateway)
        changed = True
    if agent.openclaw_session_id != session_key:
        agent.openclaw_session_id = session_key
        changed = True
    if agent.heartbeat_config is None:
        agent.heartbeat_config = DEFAULT_HEARTBEAT_CONFIG.copy()
        changed = True
    if agent.identity_profile is None:
        agent.identity_profile = _gateway_identity_profile()
        changed = True
    if not agent.status:
        agent.status = "provisioning"
        changed = True
    if changed:
        agent.updated_at = utcnow()
        session.add(agent)
    return agent, changed


async def _ensure_gateway_agents_exist(
    session: AsyncSession,
    gateways: list[Gateway],
) -> None:
    for gateway in gateways:
        agent, gateway_changed = await _upsert_main_agent_record(session, gateway)
        has_gateway_entry = await _gateway_has_main_agent_entry(gateway)
        needs_provision = gateway_changed or not bool(agent.agent_token_hash) or not has_gateway_entry
        if needs_provision:
            await _provision_main_agent_record(
                session,
                gateway,
                agent,
                user=None,
                action="provision",
                notify=False,
            )


def _extract_agent_id_from_entry(item: object) -> str | None:
    if isinstance(item, str):
        value = item.strip()
        return value or None
    if not isinstance(item, dict):
        return None
    for key in ("id", "agentId", "agent_id"):
        raw = item.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


def _extract_agents_list(payload: object) -> list[object]:
    if isinstance(payload, list):
        return [item for item in payload]
    if not isinstance(payload, dict):
        return []
    agents = payload.get("agents") or []
    if not isinstance(agents, list):
        return []
    return [item for item in agents]


async def _gateway_has_main_agent_entry(gateway: Gateway) -> bool:
    if not gateway.url:
        return False
    config = GatewayClientConfig(url=gateway.url, token=gateway.token)
    target_id = gateway_openclaw_agent_id(gateway)
    try:
        payload = await openclaw_call("agents.list", config=config)
    except OpenClawGatewayError:
        # Avoid treating transient gateway connectivity issues as a missing agent entry.
        return True
    for item in _extract_agents_list(payload):
        if _extract_agent_id_from_entry(item) == target_id:
            return True
    return False


async def _provision_main_agent_record(
    session: AsyncSession,
    gateway: Gateway,
    agent: Agent,
    *,
    user: User | None,
    action: str,
    notify: bool,
) -> Agent:
    session_key = gateway_agent_session_key(gateway)
    raw_token = generate_agent_token()
    agent.agent_token_hash = hash_agent_token(raw_token)
    agent.provision_requested_at = utcnow()
    agent.provision_action = action
    agent.updated_at = utcnow()
    if agent.heartbeat_config is None:
        agent.heartbeat_config = DEFAULT_HEARTBEAT_CONFIG.copy()
    session.add(agent)
    await session.commit()
    await session.refresh(agent)
    if not gateway.url:
        return agent
    try:
        await provision_main_agent(
            agent,
            MainAgentProvisionRequest(
                gateway=gateway,
                auth_token=raw_token,
                user=user,
                session_key=session_key,
                options=ProvisionOptions(action=action),
            ),
        )
        await ensure_session(
            session_key,
            config=GatewayClientConfig(url=gateway.url, token=gateway.token),
            label=agent.name,
        )
        if notify:
            await send_message(
                (
                    f"Hello {agent.name}. Your gateway provisioning was updated.\n\n"
                    "Please re-read AGENTS.md, USER.md, HEARTBEAT.md, and TOOLS.md. "
                    "If BOOTSTRAP.md exists, run it once then delete it. "
                    "Begin heartbeats after startup."
                ),
                session_key=session_key,
                config=GatewayClientConfig(url=gateway.url, token=gateway.token),
                deliver=True,
            )
    except OpenClawGatewayError as exc:
        logger.warning(
            "gateway.main_agent.provision_failed_gateway gateway_id=%s agent_id=%s error=%s",
            gateway.id,
            agent.id,
            str(exc),
        )
    except (OSError, RuntimeError, ValueError) as exc:
        logger.warning(
            "gateway.main_agent.provision_failed gateway_id=%s agent_id=%s error=%s",
            gateway.id,
            agent.id,
            str(exc),
        )
    except Exception as exc:  # pragma: no cover - defensive fallback
        logger.warning(
            "gateway.main_agent.provision_failed_unexpected gateway_id=%s agent_id=%s "
            "error_type=%s error=%s",
            gateway.id,
            agent.id,
            exc.__class__.__name__,
            str(exc),
        )
    return agent


async def _ensure_main_agent(
    session: AsyncSession,
    gateway: Gateway,
    auth: AuthContext,
    *,
    action: str = "provision",
) -> Agent:
    agent, _ = await _upsert_main_agent_record(session, gateway)
    return await _provision_main_agent_record(
        session,
        gateway,
        agent,
        user=auth.user,
        action=action,
        notify=True,
    )


async def _clear_agent_foreign_keys(
    session: AsyncSession,
    *,
    agent_id: UUID,
) -> None:
    now = utcnow()
    await crud.update_where(
        session,
        Task,
        col(Task.assigned_agent_id) == agent_id,
        col(Task.status) == "in_progress",
        assigned_agent_id=None,
        status="inbox",
        in_progress_at=None,
        updated_at=now,
        commit=False,
    )
    await crud.update_where(
        session,
        Task,
        col(Task.assigned_agent_id) == agent_id,
        col(Task.status) != "in_progress",
        assigned_agent_id=None,
        updated_at=now,
        commit=False,
    )
    await crud.update_where(
        session,
        ActivityEvent,
        col(ActivityEvent.agent_id) == agent_id,
        agent_id=None,
        commit=False,
    )
    await crud.update_where(
        session,
        Approval,
        col(Approval.agent_id) == agent_id,
        agent_id=None,
        commit=False,
    )


@router.get("", response_model=DefaultLimitOffsetPage[GatewayRead])
async def list_gateways(
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> LimitOffsetPage[GatewayRead]:
    """List gateways for the caller's organization."""
    gateways = await Gateway.objects.filter_by(organization_id=ctx.organization.id).all(session)
    await _ensure_gateway_agents_exist(session, gateways)
    statement = (
        Gateway.objects.filter_by(organization_id=ctx.organization.id)
        .order_by(col(Gateway.created_at).desc())
        .statement
    )
    return await paginate(session, statement)


@router.post("", response_model=GatewayRead)
async def create_gateway(
    payload: GatewayCreate,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> Gateway:
    """Create a gateway and provision or refresh its main agent."""
    data = payload.model_dump()
    gateway_id = uuid4()
    data["id"] = gateway_id
    data["organization_id"] = ctx.organization.id
    gateway = await crud.create(session, Gateway, **data)
    await _ensure_main_agent(session, gateway, auth, action="provision")
    return gateway


@router.get("/{gateway_id}", response_model=GatewayRead)
async def get_gateway(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> Gateway:
    """Return one gateway by id for the caller's organization."""
    gateway = await _require_gateway(
        session,
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    await _ensure_gateway_agents_exist(session, [gateway])
    return gateway


@router.patch("/{gateway_id}", response_model=GatewayRead)
async def update_gateway(
    gateway_id: UUID,
    payload: GatewayUpdate,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> Gateway:
    """Patch a gateway and refresh the main-agent provisioning state."""
    gateway = await _require_gateway(
        session,
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    updates = payload.model_dump(exclude_unset=True)
    await crud.patch(session, gateway, updates)
    await _ensure_main_agent(
        session,
        gateway,
        auth,
        action="update",
    )
    return gateway


@router.post("/{gateway_id}/templates/sync", response_model=GatewayTemplatesSyncResult)
async def sync_gateway_templates(
    gateway_id: UUID,
    sync_query: _TemplateSyncQuery = SYNC_QUERY_DEP,
    session: AsyncSession = SESSION_DEP,
    auth: AuthContext = AUTH_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> GatewayTemplatesSyncResult:
    """Sync templates for a gateway and optionally rotate runtime settings."""
    gateway = await _require_gateway(
        session,
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    await _ensure_gateway_agents_exist(session, [gateway])
    return await sync_gateway_templates_service(
        session,
        gateway,
        GatewayTemplateSyncOptions(
            user=auth.user,
            include_main=sync_query.include_main,
            reset_sessions=sync_query.reset_sessions,
            rotate_tokens=sync_query.rotate_tokens,
            force_bootstrap=sync_query.force_bootstrap,
            board_id=sync_query.board_id,
        ),
    )


@router.delete("/{gateway_id}", response_model=OkResponse)
async def delete_gateway(
    gateway_id: UUID,
    session: AsyncSession = SESSION_DEP,
    ctx: OrganizationContext = ORG_ADMIN_DEP,
) -> OkResponse:
    """Delete a gateway in the caller's organization."""
    gateway = await _require_gateway(
        session,
        gateway_id=gateway_id,
        organization_id=ctx.organization.id,
    )
    main_agent = await _find_main_agent(session, gateway)
    if main_agent is not None:
        await _clear_agent_foreign_keys(session, agent_id=main_agent.id)
        await session.delete(main_agent)

    duplicate_main_agents = await Agent.objects.filter_by(
        gateway_id=gateway.id,
        board_id=None,
    ).all(session)
    for agent in duplicate_main_agents:
        if main_agent is not None and agent.id == main_agent.id:
            continue
        await _clear_agent_foreign_keys(session, agent_id=agent.id)
        await session.delete(agent)

    await session.delete(gateway)
    await session.commit()
    return OkResponse()
