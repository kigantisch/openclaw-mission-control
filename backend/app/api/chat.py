"""CEO Dashboard chat proxy – bridges the browser to the OpenClaw gateway.

Provides:
* ``/chat/ws``      – persistent WebSocket that proxies chat events in real-time
* ``/chat/history`` – REST endpoint that fetches session history on page load
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from uuid import uuid4

import websockets
from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from websockets.exceptions import WebSocketException

from app.core.config import settings
from app.core.logging import get_logger

router = APIRouter(prefix="/chat", tags=["chat"])
logger = get_logger(__name__)

SESSION_KEY = "dm:main:ceo-dashboard"
SESSION_LABEL = "CEO Dashboard"
PROTOCOL_VERSION = 3


# ---------------------------------------------------------------------------
# Gateway helpers (lightweight, self-contained – no device identity needed)
# ---------------------------------------------------------------------------

def _gateway_url() -> str:
    base = settings.openclaw_gw_url.strip()
    if not base:
        raise RuntimeError("OPENCLAW_GW_URL is not configured")
    token = settings.openclaw_gw_token
    if token:
        sep = "&" if "?" in base else "?"
        return f"{base}{sep}token={token}"
    return base


async def _gateway_connect() -> websockets.ClientConnection:
    """Open a WS to the OpenClaw gateway and complete the handshake."""
    url = _gateway_url()
    ws = await websockets.connect(
        url,
        ping_interval=20,
        ping_timeout=20,
        origin="http://localhost",
    )

    # 1. Wait for optional connect.challenge
    connect_nonce: str | None = None
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=3)
        data = json.loads(raw)
        if (
            data.get("type") == "event"
            and data.get("event") == "connect.challenge"
        ):
            connect_nonce = (data.get("payload") or {}).get("nonce")
    except TimeoutError:
        pass

    # 2. Send connect request (use control-ui client ID recognized by gateway)
    connect_id = str(uuid4())
    params: dict[str, Any] = {
        "minProtocol": PROTOCOL_VERSION,
        "maxProtocol": PROTOCOL_VERSION,
        "role": "operator",
        "scopes": ["operator.read", "operator.admin"],
        "client": {
            "id": "openclaw-control-ui",
            "version": "1.0.0",
            "platform": "python",
            "mode": "ui",
        },
    }
    if settings.openclaw_gw_token:
        params["auth"] = {"token": settings.openclaw_gw_token}

    await ws.send(json.dumps({
        "type": "req",
        "id": connect_id,
        "method": "connect",
        "params": params,
    }))

    # 3. Await connect response
    while True:
        raw = await ws.recv()
        data = json.loads(raw)
        if data.get("type") == "res" and data.get("id") == connect_id:
            if data.get("ok") is False:
                err = (data.get("error") or {}).get("message", "Connect failed")
                await ws.close()
                raise RuntimeError(err)
            break

    return ws


async def _gateway_request(
    ws: websockets.ClientConnection,
    method: str,
    params: dict[str, Any] | None = None,
) -> Any:
    """Send a single RPC request on an already-connected gateway WS."""
    request_id = str(uuid4())
    await ws.send(json.dumps({
        "type": "req",
        "id": request_id,
        "method": method,
        "params": params or {},
    }))
    while True:
        raw = await ws.recv()
        data = json.loads(raw)
        if data.get("type") == "res" and data.get("id") == request_id:
            if data.get("ok") is False:
                err = (data.get("error") or {}).get("message", "Gateway error")
                raise RuntimeError(err)
            return data.get("payload")
        # Also handle older response format
        if data.get("id") == request_id:
            if data.get("error"):
                raise RuntimeError(data["error"].get("message", "Gateway error"))
            return data.get("result")


def _verify_token(token: str) -> bool:
    return token == settings.local_auth_token


# ---------------------------------------------------------------------------
# WebSocket proxy: Browser <-> Backend <-> OpenClaw Gateway
# ---------------------------------------------------------------------------

@router.websocket("/ws")
async def chat_websocket(websocket: WebSocket, token: str = Query("")):
    """Persistent WebSocket that proxies chat between browser and OpenClaw."""
    if not _verify_token(token):
        await websocket.close(code=4001, reason="Unauthorized")
        return

    await websocket.accept()
    logger.info("chat.ws.connected")

    gw_ws: websockets.ClientConnection | None = None
    try:
        # Connect to gateway
        gw_ws = await _gateway_connect()
        logger.info("chat.ws.gateway_connected")

        # Ensure session exists
        await _gateway_request(gw_ws, "sessions.patch", {
            "key": SESSION_KEY,
            "label": SESSION_LABEL,
        })

        # Notify frontend that connection is ready
        await websocket.send_json({"type": "connected"})

        # --- Bidirectional proxy ---
        async def gateway_to_frontend() -> None:
            """Forward gateway events to the browser."""
            assert gw_ws is not None
            async for raw in gw_ws:
                data = json.loads(raw)
                msg_type = data.get("type")

                if msg_type == "event" and data.get("event") == "chat":
                    payload = data.get("payload", {})
                    state = payload.get("state", "")
                    message = payload.get("message", {})

                    # Extract text from content array: [{type:"text", text:"..."}]
                    content_parts = message.get("content", [])
                    text = ""
                    if isinstance(content_parts, list):
                        text = "".join(
                            part.get("text", "")
                            for part in content_parts
                            if isinstance(part, dict) and part.get("type") == "text"
                        )
                    elif isinstance(content_parts, str):
                        text = content_parts

                    if state == "delta":
                        await websocket.send_json({
                            "type": "delta",
                            "content": text,
                        })
                    elif state == "final":
                        await websocket.send_json({
                            "type": "final",
                            "content": text,
                            "runId": payload.get("runId", ""),
                        })
                    elif state == "error":
                        await websocket.send_json({
                            "type": "error",
                            "message": text or "Unknown error",
                        })
                    else:
                        # Forward other chat states as-is
                        await websocket.send_json({
                            "type": "chat_event",
                            "state": state,
                            "content": text,
                        })

                elif msg_type == "event" and data.get("event") == "agent":
                    payload = data.get("payload", {})
                    agent_status = payload.get("status")
                    if agent_status in ("thinking", "running"):
                        await websocket.send_json({
                            "type": "status",
                            "status": "thinking",
                        })
                    elif agent_status == "idle":
                        await websocket.send_json({
                            "type": "status",
                            "status": "idle",
                        })

                # Ignore other event types (tick, presence, etc.)

        async def frontend_to_gateway() -> None:
            """Forward user messages from browser to gateway."""
            assert gw_ws is not None
            try:
                while True:
                    msg = await websocket.receive_json()
                    if msg.get("type") == "send" and msg.get("content"):
                        request_id = str(uuid4())
                        await gw_ws.send(json.dumps({
                            "type": "req",
                            "id": request_id,
                            "method": "chat.send",
                            "params": {
                                "sessionKey": SESSION_KEY,
                                "message": msg["content"],
                                "idempotencyKey": str(uuid4()),
                            },
                        }))
                    elif msg.get("type") == "abort":
                        request_id = str(uuid4())
                        await gw_ws.send(json.dumps({
                            "type": "req",
                            "id": request_id,
                            "method": "chat.abort",
                            "params": {"sessionKey": SESSION_KEY},
                        }))
            except WebSocketDisconnect:
                logger.info("chat.ws.frontend_disconnected")

        tasks = [
            asyncio.create_task(gateway_to_frontend()),
            asyncio.create_task(frontend_to_gateway()),
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        # Re-raise exceptions from completed tasks
        for task in done:
            if task.exception():
                raise task.exception()  # type: ignore[misc]

    except WebSocketDisconnect:
        logger.info("chat.ws.disconnected")
    except Exception:
        logger.exception("chat.ws.error")
        try:
            await websocket.send_json({"type": "error", "message": "Connection lost"})
        except Exception:
            pass
    finally:
        if gw_ws is not None:
            try:
                await gw_ws.close()
            except Exception:
                pass
        logger.info("chat.ws.closed")


# ---------------------------------------------------------------------------
# REST: Chat history
# ---------------------------------------------------------------------------

@router.get("/history")
async def chat_history(token: str = Query(""), limit: int = Query(default=50, ge=1, le=200)):
    """Fetch chat history for the CEO dashboard session."""
    if not _verify_token(token):
        raise HTTPException(status_code=401, detail="Unauthorized")

    try:
        gw_ws = await _gateway_connect()
        try:
            result = await _gateway_request(gw_ws, "chat.history", {
                "sessionKey": SESSION_KEY,
                "limit": limit,
            })
            # Normalize messages: extract text from content arrays
            messages = []
            raw_result = result if isinstance(result, dict) else {}
            raw_messages = raw_result.get("messages", []) if isinstance(raw_result, dict) else []
            if not isinstance(raw_messages, list):
                raw_messages = []
            for msg in raw_messages:
                if not isinstance(msg, dict):
                    continue
                role = msg.get("role", "assistant")
                content_parts = msg.get("content", [])
                if isinstance(content_parts, list):
                    text = "".join(
                        part.get("text", "")
                        for part in content_parts
                        if isinstance(part, dict) and part.get("type") == "text"
                    )
                elif isinstance(content_parts, str):
                    text = content_parts
                else:
                    text = str(content_parts)
                messages.append({
                    "role": role,
                    "content": text,
                    "timestamp": msg.get("timestamp", ""),
                })
            return {"messages": messages}
        finally:
            await gw_ws.close()
    except Exception as exc:
        logger.error("chat.history.error error=%s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
