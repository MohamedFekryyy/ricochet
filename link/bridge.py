#!/usr/bin/env python3
"""ricochet link bridge.

Browsers cannot join an Ableton Link session (Link needs UDP multicast;
the web platform has no UDP), so this tiny companion does it for the web
instrument:

- joins the Link session on your network (Ableton Live, EP-136, other
  Link apps see it as a peer)
- serves ricochet itself over plain HTTP on your LAN (a hosted https
  page is not allowed to open a ws:// connection, so the app must come
  from here)
- relays tempo/beat/phase to the app over WebSocket at 25 Hz

Setup (once):
    pip install -r link/requirements.txt

Run from the repo root:
    node scripts/build.mjs      # only if dist/ricochet.html is missing
    python3 link/bridge.py

Then open the printed URL on the phone (same wifi) and tap "link".
Tempo changes in Live follow through; tapping +/- tempo control stays
in Live (the bridge mirrors the session tempo).
"""

import argparse
import asyncio
import json
import socket
from pathlib import Path

from aalink import Link
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

ROOT = Path(__file__).resolve().parent.parent


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no traffic is sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


async def main():
    ap = argparse.ArgumentParser(description="ricochet Ableton Link bridge")
    ap.add_argument("--port", type=int, default=8780)
    ap.add_argument("--bpm", type=float, default=120.0,
                    help="tempo before a Link peer (e.g. Live) imposes its own")
    ap.add_argument("--app", default=str(ROOT / "dist" / "ricochet.html"),
                    help="path to the built single-file app")
    args = ap.parse_args()

    app_html = Path(args.app).read_text(encoding="utf-8")

    link = Link(args.bpm)
    link.enabled = True
    link.quantum = 4
    clients = set()

    def plain(connection, status, text, content_type):
        body = text.encode("utf-8")
        return Response(status, "OK", Headers([
            ("content-type", content_type),
            ("content-length", str(len(body))),
            ("connection", "close"),
        ]), body)

    def process_request(connection, request):
        if request.path == "/ws":
            return None  # continue with the websocket handshake
        path = request.path.split("?", 1)[0]  # request.path keeps the query string
        if path in ("/", "/index.html"):
            return plain(connection, 200, app_html, "text/html; charset=utf-8")
        if path == "/link-info":
            body = json.dumps({"name": "ricochet link bridge", "version": 1})
            return plain(connection, 200, body, "application/json")
        return plain(connection, 404, "not found", "text/plain")

    async def handler(ws):
        clients.add(ws)
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if msg.get("t") == "tempo":
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
                })
                await asyncio.gather(
                    *(c.send(msg) for c in list(clients)), return_exceptions=True)
            await asyncio.sleep(0.04)

    async with serve(handler, "0.0.0.0", args.port,
                     process_request=process_request):
        print("ricochet link bridge is up")
        print(f"  open on the phone: http://{lan_ip()}:{args.port}")
        print(f"  link session at {link.tempo:.1f} bpm; "
              "enable Link in Ableton Live to join")
        await broadcast()


if __name__ == "__main__":
    asyncio.run(main())
