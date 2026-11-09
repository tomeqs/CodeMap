"""Node ids. They depend only on paths and names, so the same code gets the same ids whatever was analyzed
with it (one package or the whole repository)."""
from __future__ import annotations

import re


def project_id(project: str) -> str:
    return f"py:project:{project}"


def namespace_id(project: str, package: str) -> str:
    return f"py:ns:{project}/{package or ROOT_PACKAGE}"


def module_id(project: str, path: str) -> str:
    return f"py:{project}:{path}"


def member_id(module: str, qualname: str) -> str:
    return f"{module}#{qualname}"


def package_id(distribution: str) -> str:
    return f"py:pypi:{normalize(distribution)}"


def normalize(distribution: str) -> str:
    """A distribution's name as PyPI compares them (PEP 503): Django_REST-framework → django-rest-framework."""
    return re.sub(r"[-_.]+", "-", distribution).lower()


ROOT_PACKAGE = "(root)"
TOP_LEVEL = "(top-level)"
