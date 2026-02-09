"""Helpers for dedicated gateway-scoped agent identity/session keys."""

from __future__ import annotations

from uuid import UUID

from app.models.gateways import Gateway

_GATEWAY_AGENT_PREFIX = "agent:gateway-"
_GATEWAY_AGENT_SUFFIX = ":main"
_GATEWAY_OPENCLAW_AGENT_PREFIX = "mc-gateway-"


def gateway_agent_session_key_for_id(gateway_id: UUID) -> str:
    """Return the dedicated Mission Control gateway-agent session key for an id."""
    return f"{_GATEWAY_AGENT_PREFIX}{gateway_id}{_GATEWAY_AGENT_SUFFIX}"


def gateway_agent_session_key(gateway: Gateway) -> str:
    """Return the dedicated Mission Control gateway-agent session key."""
    return gateway_agent_session_key_for_id(gateway.id)


def gateway_openclaw_agent_id_for_id(gateway_id: UUID) -> str:
    """Return the dedicated OpenClaw config `agentId` for a gateway agent."""
    return f"{_GATEWAY_OPENCLAW_AGENT_PREFIX}{gateway_id}"


def gateway_openclaw_agent_id(gateway: Gateway) -> str:
    """Return the dedicated OpenClaw config `agentId` for a gateway agent."""
    return gateway_openclaw_agent_id_for_id(gateway.id)
