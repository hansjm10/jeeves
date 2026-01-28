"""Jeeves SDK Runner - Agent SDK-based runner for Jeeves."""

# Note: We use lazy imports here to avoid issues when running
# `python -m jeeves.runner.sdk_runner` - the module should not be
# imported until explicitly requested.


def __getattr__(name):
    """Lazy import to avoid module import order issues."""
    if name in ("run_agent", "main", "SDKRunner"):
        from . import sdk_runner
        return getattr(sdk_runner, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["run_agent", "main", "SDKRunner"]
