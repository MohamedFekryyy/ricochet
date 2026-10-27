#!/usr/bin/env python3
"""ricochet link bridge (experimental).

Browsers cannot use Ableton's documented Link integration routes (iOS
LinkKit, the cross-platform C++ SDK), so this small companion joins the
Link session for the web instrument:

- joins the Link session on your network (Ableton Live, EP-136, other
  Link apps see it as a peer)
- serves ricochet itself over plain HTTP on your LAN (a hosted https
  page is not allowed to open a ws:// connection, so the app must come
  from here)
- relays tempo/beat/phase to the app over WebSocket at 25 Hz, with
  ping/pong so the app can estimate network delay

Access is gated by a random per-run key in the printed URL: anyone on
the network who does not have the URL gets 404s. Cross-origin websocket
handshakes (a malicious website trying to reach the bridge from your
browser) are rejected. Sync is read-only by default - nothing on the
network can change your session tempo unless you pass
--allow-remote-tempo.

Setup (once):
    pip install -r link/requirements.txt

Run from the repo root:
    node scripts/build.mjs      # only if dist/ricochet.html is missing
    python3 link/bridge.py

Then open the printed URL on the phone (same wifi) and tap "link".
"""

import argparse
import asyncio
import json
import secrets
import socket
import time
from pathlib import Path

from aalink import Link
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

ROOT = Path(__file__).resolve().parent.parent
STATE_INTERVAL = 0.04  # 25 Hz


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no traffic is sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def now_ms():
    return time.monotonic() * 1000.0


async def main():
    ap = argparse.ArgumentParser(description="ricochet Ableton Link bridge")
    ap.add_argument("--port", type=int, default=8780)
    ap.add_argument("--bpm", type=float, default=120.0,
                    help="tempo before a Link peer (e.g. Live) imposes its own")
    ap.add_argument("--app", default=str(ROOT / "dist" / "ricochet.html"),
                    help="path to the built single-file app")
    ap.add_argument("--allow-remote-tempo", action="store_true",
                    help="let connected clients change the session tempo "
                         "(OFF by default: sync is read-only)")
    args = ap.parse_args()

    app_html = Path(args.app).read_text(encoding="utf-8")
    key = secrets.token_urlsafe(12)

    link = Link(args.bpm)
    link.enabled = True
    link.quantum = 4
    clients = set()

    def response(status, text, content_type):
        body = text.encode("utf-8")
        return Response(status, "OK", Headers([
            ("content-type", content_type),
            ("content-length", str(len(body))),
            ("connection", "close"),
        ]), body)

    def authorized(request):
        query = request.path.split("?", 1)[1] if "?" in request.path else ""
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
        return params.get("key") == key

    def process_request(connection, request):
        path = request.path.split("?", 1)[0]  # request.path keeps the query string
        if path == "/ws":
            if not authorized(request):
                return response(404, "not found", "text/plain")
            # Reject cross-origin handshakes: a browser on another site
            # must not reach the bridge. Native clients send no Origin.
            origin = request.headers.get("Origin")
            if origin is not None:
                from urllib.parse import urlparse
                origin_host = urlparse(origin).netloc.lower()
                host = (request.headers.get("Host") or "").lower()
                if origin_host != host:
                    return response(403, "forbidden", "text/plain")
            return None  # continue with the websocket handshake
        if not authorized(request):
            return response(404, "not found", "text/plain")
        if path in ("/", "/index.html"):
            return response(200, app_html, "text/html; charset=utf-8")
        if path == "/link-info":
            body = json.dumps({"name": "ricochet link bridge", "version": 2})
            return response(200, body, "application/json")
        return response(404, "not found", "text/plain")

    async def handler(ws):
        clients.add(ws)
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                t = msg.get("t")
                if t == "ping":
                    # clock-sync: echo the client stamp with our timeline
                    await ws.send(json.dumps({
                        "t": "pong", "c": msg.get("c"), "ts": now_ms(),
                        "beat": link.beat, "bpm": link.tempo,
                    }))
                elif t == "tempo":
                    if not args.allow_remote_tempo:
                        continue  # read-only by default
                    try:
                        bpm = float(msg.get("bpm", 0))
                    except (TypeError, ValueError):
                        continue
                    if 20 <= bpm <= 300:
                        link.tempo = bpm
        finally:
            clients.discard(ws)

    async def broadcast():
        while True:
            if clients:
                msg = json.dumps({
                    "t": "state",
                    "bpm": link.tempo,
                    "beat": link.beat,
                    "phase": link.phase,
                    "quantum": link.quantum,
                    "peers": link.num_peers,
                    "playing": link.playing,
                    "ts": now_ms(),
                })
                await asyncio.gather(
                    *(c.send(msg) for c in list(clients)), return_exceptions=True)
            await asyncio.sleep(STATE_INTERVAL)

    async with serve(handler, "0.0.0.0", args.port,
                     process_request=process_request):
        url = f"http://{lan_ip()}:{args.port}/?key={key}"
        print("ricochet link bridge is up (experimental)")
        print(f"  open on the phone: {url}")
        print(f"  link session at {link.tempo:.1f} bpm; "
              "enable Link in Ableton Live to join")
        print(f"  remote tempo changes: "
              f"{'ALLOWED' if args.allow_remote_tempo else 'ignored (read-only sync)'}")
        await broadcast()


if __name__ == "__main__":
    asyncio.run(main())
