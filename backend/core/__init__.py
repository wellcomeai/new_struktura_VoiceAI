"""
Core module initialization.
This module contains core functionality for the WellcomeAI application.
"""

from .config import settings
from .logging import get_logger, setup_logging

# Initialize logging system on import
setup_logging()

# Create a logger for this module
logger = get_logger(__name__)
logger.info("Core module initialized")

# Export only specific items from this module (optional)
__all__ = ["settings", "get_logger", "setup_logging"]
