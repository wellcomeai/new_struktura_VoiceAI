import os
import sys
import importlib
import importlib.util
import importlib.abc
import types
import uvicorn
import logging
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Add current directory to Python path
current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.append(current_dir)

# Database schema initialization - только создание таблиц
from backend.db.session import engine
from backend.models.base import Base

# Создаем таблицы только если они не существуют
Base.metadata.create_all(bind=engine)

# Meta import configuration
class BackendImportFinder(importlib.abc.MetaPathFinder):
    """
    Finder for redirecting imports without prefix to backend package.
    E.g., 'core.config' -> 'backend.core.config'
    """
    def __init__(self):
        self.prefix = 'backend.'
        self.main_modules = ['core', 'db', 'models', 'schemas', 'services', 'utils', 'api']
        self.imported_modules = set()

    def find_spec(self, fullname, path, target=None):
        if fullname in sys.modules:
            return None
        if fullname == 'websockets' or fullname.startswith('websockets.'):
            return None
        parts = fullname.split('.')
        if parts[0] not in self.main_modules:
            return None
        backend_name = self.prefix + fullname
        try:
            spec = importlib.util.find_spec(backend_name)
            if spec:
                self.imported_modules.add(fullname)
                loader = BackendImportLoader(fullname, backend_name)
                return importlib.machinery.ModuleSpec(fullname, loader)
        except (ImportError, AttributeError):
            pass
        return None

class BackendImportLoader(importlib.abc.Loader):
    """Loader for modules redirected to backend."""
    def __init__(self, fullname, backend_name):
        self.fullname = fullname
        self.backend_name = backend_name

    def create_module(self, spec):
        if self.fullname in sys.modules:
            return sys.modules[self.fullname]
        try:
            backend_module = importlib.import_module(self.backend_name)
            module = types.ModuleType(self.fullname)
            for attr in dir(backend_module):
                if not attr.startswith('__'):
                    setattr(module, attr, getattr(backend_module, attr))
            module.__file__ = getattr(backend_module, '__file__', None)
            module.__name__ = self.fullname
            module.__package__ = self.fullname.rpartition('.')[0] or None
            if '.' in self.fullname:
                parent_name, _, child_name = self.fullname.rpartition('.')
                if parent_name in sys.modules:
                    setattr(sys.modules[parent_name], child_name, module)
            sys.modules[self.fullname] = module
            return module
        except Exception as e:
            print(f"Error loading module {self.fullname}: {e}")
            return None

    def exec_module(self, module):
        pass

# Insert our import finder
sys.meta_path.insert(0, BackendImportFinder())

# Settings for running
PORT = int(os.getenv('PORT', 5050))
DEBUG = os.getenv('DEBUG', 'False').lower() == 'true'
LOG_LEVEL = os.getenv('LOG_LEVEL', 'info').lower()

# Import FastAPI app
from app import app

# Expose application for Gunicorn
application = app

# Configure root logger
logger = logging.getLogger("wellcome-ai")

if __name__ == "__main__":
    logger.info(f"Starting server on port {PORT}, debug={DEBUG}")
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=PORT,
        log_level=LOG_LEVEL,
        reload=DEBUG,
        workers=1 if DEBUG else None,
        timeout_keep_alive=120,
    )
