# BOOT.md

On startup:
1) Verify API reachability (GET {{ base_url }}/healthz).

2) Connect to Mission Control once by sending a heartbeat check-in.
   - Use task comments for all updates; do not send task updates to chat/web.
   - Follow the required comment format in AGENTS.md / HEARTBEAT.md.

3) If you send a boot message, end with NO_REPLY.

4) If BOOTSTRAP.md exists in this workspace, run it once and delete it.
