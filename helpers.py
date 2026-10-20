import importlib
import os
import shutil
import time
from datetime import datetime
from pprint import pprint

import solvers

ROUND_TRIP = 50


_mtime = os.path.getmtime(solvers.__file__)


def reload_solvers() -> bool:
    """Reload solvers.py if it changed on disk. Returns True if it reloaded."""
    global _mtime
    m = os.path.getmtime(solvers.__file__)
    if m == _mtime:
        return False
    _mtime = m  # a broken file is tried once, saving it again retries
    try:
        importlib.reload(solvers)
        log(f"[solvers reloaded] {list(solvers.REGISTRY)}")
        return True
    except Exception as e:
        log(f"[reload failed], keeping old solvers: {e!r}")
        return False


def sleep_ms(ms):
    time.sleep(ms / 1000)


def RT(ms):
    return ms - ROUND_TRIP


def log_http_error(action, e):
    print(f"[{action} failed] ! ({e.response.status_code}): {e.response.text}")


def write_last_token(token):
    with open("acces-token.txt", "w") as file:
        file.write(token)
        print("wrote the new access token")


def date():
    return datetime.now().strftime("%H:%M:%S")


def log(msg):
    print(f"{datetime.now().strftime('%H:%M:%S.%f')[:-3]} {msg}", flush=True)


def pp(obj):
    pprint(obj, width=shutil.get_terminal_size().columns, sort_dicts=False)
