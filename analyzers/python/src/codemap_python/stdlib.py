"""Top-level modules of Python's standard library, 3.9 to 3.13, with those later versions removed.

A fixed list rather than sys.stdlib_module_names, so the map is the same whichever Python runs the analysis.
"""
from __future__ import annotations

MODULES = frozenset("""
__future__ __main__ _thread abc aifc antigravity argparse array ast asynchat asyncio asyncore atexit audioop base64
bdb binascii binhex bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections
colorsys compileall concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses
datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp
fileinput fnmatch formatter fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip
hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3
linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing
netrc nis nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev parser pathlib pdb pickle
pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr
pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select
selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile
sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symbol symtable sys sysconfig
syslog tabnanny tarfile telnetlib tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib
trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave
weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo
""".split())


def is_stdlib(top_level: str) -> bool:
    return top_level in MODULES or top_level.startswith("_") and top_level[1:] in MODULES
