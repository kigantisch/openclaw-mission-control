"""Pydantic/SQLModel schemas for agent API payloads."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import field_validator
from sqlmodel import SQLModel

from app.schemas.common import NonEmptyStr

_RUNTIME_TYPE_REFERENCES = (datetime, UUID, NonEmptyStr)


def _normalize_identity_profile(
    profile: object,
) -> dict[str, str] | None:
    if not isinstance(profile, Mapping):
        return None
    normalized: dict[str, str] = {}
    for raw_key, raw in profile.items():
        if raw is None:
            continue
        key = str(raw_key).strip()
        if not key:
            continue
        if isinstance(raw, list):
            parts = [str(item).strip() for item in raw if str(item).strip()]
            if not parts:
                continue
            normalized[key] = ", ".join(parts)
            continue
        value = str(raw).strip()
        if value:
            normalized[key] = value
    return normalized or None


class AgentBase(SQLModel):
    """Common fields shared by agent create/read/update payloads."""

    board_id: UUID | None = None
    name: NonEmptyStr
    status: str = "provisioning"
    heartbeat_config: dict[str, Any] | None = None
    identity_profile: dict[str, Any] | None = None
    identity_template: str | None = None
    soul_template: str | None = None

    @field_validator("identity_template", "soul_template", mode="before")
    @classmethod
    def normalize_templates(cls, value: object) -> object | None:
        """Normalize blank template text to null."""
        if value is None:
            return None
        if isinstance(value, str):
            value = value.strip()
            return value or None
        return value

    @field_validator("identity_profile", mode="before")
    @classmethod
    def normalize_identity_profile(
        cls,
        value: object,
    ) -> dict[str, str] | None:
        """Normalize identity-profile values into trimmed string mappings."""
        return _normalize_identity_profile(value)


class AgentCreate(AgentBase):
    """Payload for creating a new agent."""


class AgentUpdate(SQLModel):
    """Payload for patching an existing agent."""

    board_id: UUID | None = None
    is_gateway_main: bool | None = None
    name: NonEmptyStr | None = None
    status: str | None = None
    heartbeat_config: dict[str, Any] | None = None
    identity_profile: dict[str, Any] | None = None
    identity_template: str | None = None
    soul_template: str | None = None

    @field_validator("identity_template", "soul_template", mode="before")
    @classmethod
    def normalize_templates(cls, value: object) -> object | None:
        """Normalize blank template text to null."""
        if value is None:
            return None
        if isinstance(value, str):
            value = value.strip()
            return value or None
        return value

    @field_validator("identity_profile", mode="before")
    @classmethod
    def normalize_identity_profile(
        cls,
        value: object,
    ) -> dict[str, str] | None:
        """Normalize identity-profile values into trimmed string mappings."""
        return _normalize_identity_profile(value)


class AgentRead(AgentBase):
    """Public agent representation returned by the API."""

    id: UUID
    gateway_id: UUID
    is_board_lead: bool = False
    is_gateway_main: bool = False
    openclaw_session_id: str | None = None
    last_seen_at: datetime | None
    created_at: datetime
    updated_at: datetime


class AgentHeartbeat(SQLModel):
    """Heartbeat status payload sent by agents."""

    status: str | None = None


class AgentHeartbeatCreate(AgentHeartbeat):
    """Heartbeat payload used to create an agent lazily."""

    name: NonEmptyStr
    board_id: UUID | None = None


class AgentNudge(SQLModel):
    """Nudge message payload for pinging an agent."""

    message: NonEmptyStr
