"""
Functions module for WellcomeAI application.
Contains all function definitions that can be used by assistants.
"""

from .registry import register_function, get_function, get_all_functions
# Import specific function modules to register them
from . import integrations
from . import data_processing

__all__ = [
    "register_function",
    "get_function",
    "get_all_functions"
]
