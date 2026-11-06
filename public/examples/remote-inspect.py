"""Phonebase remote read-only check. Python 3.10+; standard library only."""
import json
import os
import urllib.error
import urllib.parse
import urllib.request


def main():
    base = os.environ.get("PHONEBASE_API_URL", "").rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    token = os.environ.get("PHONEBASE_API_TOKEN", "").strip()
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise ValueError("Set PHONEBASE_API_URL to the HTTPS station origin.")
    if not token:
        raise ValueError("Set PHONEBASE_API_TOKEN to the decoded customer key.")
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    request = urllib.request.Request(base + "/api/v1/devices", headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "User-Agent": "Phonebase-Python-Example/0.7",
    })
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            devices = json.load(response)["devices"]
    except urllib.error.HTTPError as error:
        raise RuntimeError("Station returned HTTP " + str(error.code)) from None
    print(json.dumps([{"id": device["id"], "connected": device.get("connected"), "capabilities": device.get("capabilities")} for device in devices], indent=2))
    print("Read-only connection verified. No physical action was sent.")


if __name__ == "__main__":
    main()
