"""Tiny HTTP helper with timeouts, retries and polite pacing. Injected into modules so tests need no network."""
import time

import requests


class Http:
    def __init__(self, user_agent, pace=0.0, retries=2, timeout=25):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": user_agent, "Accept": "application/json,text/csv,*/*"})
        self.pace = pace
        self.retries = retries
        self.timeout = timeout

    def get(self, url, **kw):
        last = None
        for i in range(self.retries + 1):
            try:
                r = self.s.get(url, timeout=self.timeout, **kw)
                if r.status_code == 429 or r.status_code >= 500:
                    last = RuntimeError(f"{url} -> {r.status_code}")
                    time.sleep(1.5 * (i + 1))
                    continue
                if self.pace:
                    time.sleep(self.pace)
                return r
            except requests.RequestException as e:  # network error: retry
                last = e
                time.sleep(1.0 * (i + 1))
        raise last or RuntimeError(f"{url} failed")

    def json(self, url, **kw):
        r = self.get(url, **kw)
        if r.status_code != 200:
            raise RuntimeError(f"{url} -> {r.status_code}")
        return r.json()

    def text(self, url, **kw):
        r = self.get(url, **kw)
        if r.status_code != 200:
            raise RuntimeError(f"{url} -> {r.status_code}")
        return r.text
