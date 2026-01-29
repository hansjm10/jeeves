"""Tests for the context tracking module."""

import importlib.util
import sys
from pathlib import Path


def get_repo_root() -> Path:
    """Get the repository root directory."""
    return Path(__file__).parent.parent


def load_module_from_path(module_name: str, file_path: Path):
    """Load a Python module from a specific file path.

    This allows us to import modules from src/jeeves/context even when
    an older version of jeeves is installed in the environment.

    Args:
        module_name: Name to assign to the loaded module.
        file_path: Path to the .py file.

    Returns:
        The loaded module.
    """
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load module from {file_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def load_context_modules():
    """Load all context module components."""
    repo_root = get_repo_root()
    context_dir = repo_root / "src" / "jeeves" / "context"

    # Load modules in dependency order
    constants = load_module_from_path(
        "jeeves.context.constants", context_dir / "constants.py"
    )
    models = load_module_from_path("jeeves.context.models", context_dir / "models.py")
    service = load_module_from_path(
        "jeeves.context.service", context_dir / "service.py"
    )
    init = load_module_from_path("jeeves.context", context_dir / "__init__.py")

    return constants, models, service, init


class TestContextModuleStructure:
    """Tests for verifying context module structure exists."""

    def test_context_directory_exists(self):
        """Verify src/jeeves/context directory exists."""
        repo_root = get_repo_root()
        context_dir = repo_root / "src" / "jeeves" / "context"
        assert context_dir.exists(), f"context directory should exist at {context_dir}"
        assert context_dir.is_dir(), "context should be a directory"

    def test_context_init_exists(self):
        """Verify context __init__.py exists."""
        repo_root = get_repo_root()
        init_file = repo_root / "src" / "jeeves" / "context" / "__init__.py"
        assert init_file.exists(), f"__init__.py should exist at {init_file}"
        assert init_file.is_file(), "__init__.py should be a file"

    def test_context_constants_exists(self):
        """Verify context constants.py exists."""
        repo_root = get_repo_root()
        constants_file = repo_root / "src" / "jeeves" / "context" / "constants.py"
        assert constants_file.exists(), f"constants.py should exist at {constants_file}"
        assert constants_file.is_file(), "constants.py should be a file"

    def test_context_models_exists(self):
        """Verify context models.py exists."""
        repo_root = get_repo_root()
        models_file = repo_root / "src" / "jeeves" / "context" / "models.py"
        assert models_file.exists(), f"models.py should exist at {models_file}"
        assert models_file.is_file(), "models.py should be a file"

    def test_context_service_exists(self):
        """Verify context service.py exists."""
        repo_root = get_repo_root()
        service_file = repo_root / "src" / "jeeves" / "context" / "service.py"
        assert service_file.exists(), f"service.py should exist at {service_file}"
        assert service_file.is_file(), "service.py should be a file"


class TestContextConstants:
    """Tests for context window constants."""

    def test_known_models_have_context_windows(self):
        """Verify all known models have defined context windows."""
        constants, _, _, _ = load_context_modules()
        assert "claude-sonnet" in constants.MODEL_CONTEXT_WINDOWS
        assert "claude-opus" in constants.MODEL_CONTEXT_WINDOWS
        assert "claude-haiku" in constants.MODEL_CONTEXT_WINDOWS

    def test_default_context_window_exists(self):
        """Verify default context window is defined."""
        constants, _, _, _ = load_context_modules()
        assert hasattr(constants, "DEFAULT_CONTEXT_WINDOW")
        assert constants.DEFAULT_CONTEXT_WINDOW == 200_000

    def test_all_context_windows_are_positive(self):
        """Verify all context windows are positive integers."""
        constants, _, _, _ = load_context_modules()
        for model, window in constants.MODEL_CONTEXT_WINDOWS.items():
            assert window > 0, f"Context window for {model} should be positive"
            assert isinstance(window, int), f"Context window for {model} should be int"


class TestTokenUsage:
    """Tests for TokenUsage dataclass."""

    def test_total_input_calculation(self):
        """Verify total_input includes cache tokens."""
        _, models, _, _ = load_context_modules()
        usage = models.TokenUsage(
            input_tokens=1000,
            cache_creation_tokens=200,
            cache_read_tokens=300,
        )
        assert usage.total_input == 1500

    def test_total_calculation(self):
        """Verify total includes input and output."""
        _, models, _, _ = load_context_modules()
        usage = models.TokenUsage(
            input_tokens=1000,
            output_tokens=500,
            cache_creation_tokens=200,
            cache_read_tokens=300,
        )
        assert usage.total == 2000  # 1000 + 200 + 300 + 500

    def test_default_values(self):
        """Verify default values are zero."""
        _, models, _, _ = load_context_modules()
        usage = models.TokenUsage()
        assert usage.input_tokens == 0
        assert usage.output_tokens == 0
        assert usage.cache_creation_tokens == 0
        assert usage.cache_read_tokens == 0
        assert usage.total_input == 0
        assert usage.total == 0


class TestContextStats:
    """Tests for ContextStats dataclass."""

    def test_to_dict(self):
        """Verify to_dict returns expected keys."""
        _, models, _, _ = load_context_modules()
        stats = models.ContextStats(
            percentage=45.2,
            percentage_raw=45.2,
            total_input_tokens=90400,
            context_window_size=200000,
            is_near_limit=False,
            is_over_limit=False,
        )
        d = stats.to_dict()
        assert "percentage" in d
        assert "total_input_tokens" in d
        assert "context_window_size" in d
        assert "is_near_limit" in d
        assert d["percentage"] == 45.2


class TestContextService:
    """Tests for ContextService."""

    def test_percentage_bounded_at_100(self):
        """Verify percentage never exceeds 100."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        # Simulate tokens exceeding context window
        svc.update(input_tokens=300_000)
        assert svc.get_percentage() == 100.0
        assert svc.get_percentage_raw() > 100.0

    def test_percentage_bounded_at_0(self):
        """Verify percentage never goes below 0."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        assert svc.get_percentage() == 0.0

    def test_model_context_window_lookup(self):
        """Verify correct context window for known models."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService(model="claude-sonnet")
        assert svc.context_window_size == 200_000

    def test_unknown_model_uses_default(self):
        """Verify unknown models use default context window."""
        constants, _, service, _ = load_context_modules()
        svc = service.ContextService(model="unknown-model-xyz")
        assert svc.context_window_size == constants.DEFAULT_CONTEXT_WINDOW

    def test_format_summary_normal(self):
        """Verify format_summary output."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        svc.update(input_tokens=50_000)
        summary = svc.format_summary()
        assert "25.0%" in summary
        assert "200K" in summary

    def test_format_summary_over_limit(self):
        """Verify format_summary includes warning when over limit."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        svc.update(input_tokens=250_000)
        summary = svc.format_summary()
        assert "WARNING" in summary

    def test_stats_is_near_limit(self):
        """Verify is_near_limit flag at 80%."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        svc.update(input_tokens=160_000)  # 80%
        stats = svc.get_stats()
        assert stats.is_near_limit is True

    def test_stats_is_not_near_limit(self):
        """Verify is_near_limit flag below 80%."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        svc.update(input_tokens=100_000)  # 50%
        stats = svc.get_stats()
        assert stats.is_near_limit is False

    def test_update_from_dict(self):
        """Verify update_from_dict handles SDK format."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        svc.update_from_dict(
            {
                "input_tokens": 1000,
                "output_tokens": 500,
                "cache_creation_input_tokens": 100,
                "cache_read_input_tokens": 50,
            }
        )
        # Total input should be 1000 + 100 + 50 = 1150
        stats = svc.get_stats()
        assert stats.total_input_tokens == 1150

    def test_reset(self):
        """Verify reset clears usage."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        svc.update(input_tokens=100_000)
        assert svc.get_percentage() > 0
        svc.reset()
        assert svc.get_percentage() == 0.0

    def test_model_property(self):
        """Verify model property returns the configured model."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService(model="claude-opus")
        assert svc.model == "claude-opus"

    def test_percentage_rounding(self):
        """Verify percentage is rounded to 1 decimal place."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        # 33333 / 200000 = 16.6665%
        svc.update(input_tokens=33_333)
        stats = svc.get_stats()
        # Should be rounded to 16.7%
        assert stats.percentage == 16.7

    def test_prefix_matching_for_versioned_models(self):
        """Verify prefix matching works for versioned model names."""
        _, _, service, _ = load_context_modules()
        # Should match "claude-sonnet" prefix
        svc = service.ContextService(model="claude-sonnet-4-20250514")
        assert svc.context_window_size == 200_000


class TestContextModuleExports:
    """Tests for verifying module exports."""

    def test_init_exports_context_service(self):
        """Verify __init__ exports ContextService."""
        _, _, _, init = load_context_modules()
        assert hasattr(init, "ContextService")

    def test_init_exports_context_stats(self):
        """Verify __init__ exports ContextStats."""
        _, _, _, init = load_context_modules()
        assert hasattr(init, "ContextStats")

    def test_init_exports_token_usage(self):
        """Verify __init__ exports TokenUsage."""
        _, _, _, init = load_context_modules()
        assert hasattr(init, "TokenUsage")

    def test_init_exports_model_context_windows(self):
        """Verify __init__ exports MODEL_CONTEXT_WINDOWS."""
        _, _, _, init = load_context_modules()
        assert hasattr(init, "MODEL_CONTEXT_WINDOWS")

    def test_init_exports_default_context_window(self):
        """Verify __init__ exports DEFAULT_CONTEXT_WINDOW."""
        _, _, _, init = load_context_modules()
        assert hasattr(init, "DEFAULT_CONTEXT_WINDOW")


class TestEdgeCases:
    """Tests for edge cases and error handling."""

    def test_zero_context_window(self):
        """Verify handling of zero context window."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        # Manually set zero context window
        svc._context_window = 0
        svc.update(input_tokens=1000)
        # Should return 0 to avoid division by zero
        assert svc.get_percentage_raw() == 0.0
        assert svc.get_percentage() == 0.0

    def test_very_large_token_count(self):
        """Verify handling of very large token counts."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        # 10x the context window
        svc.update(input_tokens=2_000_000)
        # Raw should be 1000%, bounded should be 100%
        assert svc.get_percentage_raw() == 1000.0
        assert svc.get_percentage() == 100.0
        stats = svc.get_stats()
        assert stats.is_over_limit is True

    def test_cache_tokens_included_in_total(self):
        """Verify cache tokens are included in total input calculation."""
        _, _, service, _ = load_context_modules()
        svc = service.ContextService()
        svc.update(
            input_tokens=100_000,
            cache_creation_tokens=25_000,
            cache_read_tokens=25_000,
        )
        # Total should be 150_000 (75% of 200K)
        stats = svc.get_stats()
        assert stats.total_input_tokens == 150_000
        assert stats.percentage == 75.0
