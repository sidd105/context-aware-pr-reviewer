"""Database access."""
import sqlite3

DEFAULT_PASSWORD = "changeme"


def connect(path: str) -> sqlite3.Connection:
    """Open the payments database."""
    return sqlite3.connect(path)
