# backend/services/google_sheets_service.py
"""
🔍 ENHANCED LOGGING VERSION - Google Sheets service
Maximum logging for debugging and monitoring
✅ v2.0: Added Conversation ID tracking
"""

import os
import json
import asyncio
import time
import traceback
import sys
import google.auth.transport.requests
from datetime import datetime
from typing import Dict, Any, Optional, List

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from backend.core.logging import get_logger

logger = get_logger(__name__)

# Force immediate log flushing
import logging
logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    force=True
)

def log_sheets(message: str, level: str = "INFO"):
    """Force log to stdout immediately"""
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    log_msg = f"{timestamp} - [GOOGLE-SHEETS] {level} - {message}"
    print(log_msg, flush=True)
    if level == "ERROR":
        logger.error(message)
    elif level == "WARNING":
        logger.warning(message)
    else:
        logger.info(message)

# Load service account
try:
    GOOGLE_SERVICE_ACCOUNT_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if GOOGLE_SERVICE_ACCOUNT_JSON:
        SERVICE_ACCOUNT_INFO = json.loads(GOOGLE_SERVICE_ACCOUNT_JSON)
        
        # Fix private key format
        if "private_key" in SERVICE_ACCOUNT_INFO:
            SERVICE_ACCOUNT_INFO["private_key"] = SERVICE_ACCOUNT_INFO["private_key"].replace('\\n', '\n')
            log_sheets("Private key format corrected")
        
        log_sheets(f"Service account loaded: {SERVICE_ACCOUNT_INFO.get('client_email', 'unknown')}")
    else:
        log_sheets("GOOGLE_SERVICE_ACCOUNT_JSON environment variable not found", "ERROR")
        SERVICE_ACCOUNT_INFO = {}
except json.JSONDecodeError as e:
    log_sheets(f"JSON decode error: {str(e)}", "ERROR")
    SERVICE_ACCOUNT_INFO = {}
except Exception as e:
    log_sheets(f"Unexpected error loading service account: {str(e)}", "ERROR")
    SERVICE_ACCOUNT_INFO = {}

class GoogleSheetsService:
    """Service for Google Sheets with enhanced logging and Conversation ID tracking"""
    
    _service = None
    
    @classmethod
    def _get_sheets_service(cls):
        """Get Google Sheets API service with detailed logging"""
        if cls._service is not None:
            log_sheets("Using cached Sheets service")
            return cls._service
            
        try:
            log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            log_sheets("🔧 INITIALIZING GOOGLE SHEETS SERVICE")
            log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            
            # Check service account data
            if not SERVICE_ACCOUNT_INFO or "private_key" not in SERVICE_ACCOUNT_INFO:
                log_sheets("❌ Missing service account data", "ERROR")
                if SERVICE_ACCOUNT_INFO:
                    log_sheets(f"Available keys: {', '.join(SERVICE_ACCOUNT_INFO.keys())}", "ERROR")
                raise ValueError("Missing service account data. Check GOOGLE_SERVICE_ACCOUNT_JSON")
            
            # Log safe account info
            safe_info = {k: v for k, v in SERVICE_ACCOUNT_INFO.items() if k != "private_key"}
            safe_info["private_key"] = "[HIDDEN]"
            log_sheets(f"Service account info: {json.dumps(safe_info, indent=2)}")
            
            # Create credentials
            try:
                log_sheets("Creating credentials...")
                credentials = service_account.Credentials.from_service_account_info(
                    SERVICE_ACCOUNT_INFO,
                    scopes=['https://www.googleapis.com/auth/spreadsheets']
                )
                log_sheets(f"✅ Credentials created for: {credentials.service_account_email}")
            except Exception as e:
                log_sheets(f"❌ Credentials creation failed: {str(e)}", "ERROR")
                raise
            
            # Get token
            log_sheets("Refreshing token...")
            request = google.auth.transport.requests.Request()
            credentials.refresh(request)
            log_sheets("✅ Token obtained successfully")
            
            # Create service
            log_sheets("Building Sheets API service...")
            service = build('sheets', 'v4', credentials=credentials, cache_discovery=False)
            cls._service = service
            log_sheets("✅ Google Sheets API service initialized")
            log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            
            return service
        except Exception as e:
            log_sheets(f"❌ CRITICAL: Service initialization failed: {str(e)}", "ERROR")
            log_sheets(f"Traceback: {traceback.format_exc()}", "ERROR")
            raise
    
    @staticmethod
    async def log_conversation(
        sheet_id: str,
        user_message: str,
        assistant_message: str,
        function_result: Optional[Dict[str, Any]] = None,
        conversation_id: Optional[str] = None  # 🆕 v2.0: Added conversation ID
    ) -> bool:
        """
        Log conversation to Google Sheets with detailed logging
        
        Args:
            sheet_id: Google Sheet ID
            user_message: User's message
            assistant_message: Assistant's response
            function_result: Optional function execution result
            conversation_id: Optional unique conversation identifier (UUID)
        
        Returns:
            bool: Success status
        """
        if not sheet_id:
            log_sheets("⚠️ No sheet ID provided", "WARNING")
            return False
        
        try:
            log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            log_sheets("📊 STARTING GOOGLE SHEETS LOGGING v2.0")
            log_sheets(f"   Sheet ID: {sheet_id}")
            if conversation_id:
                log_sheets(f"   Conversation ID: {conversation_id}")
            log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            
            # Validate messages
            if not user_message and not assistant_message:
                log_sheets("⚠️ Both messages empty, skipping", "WARNING")
                return False
            
            # Set defaults
            user_message = user_message or "(empty message)"
            assistant_message = assistant_message or "(empty response)"
            
            log_sheets(f"📝 User message: {user_message[:100]}... ({len(user_message)} chars)")
            log_sheets(f"🤖 Assistant message: {assistant_message[:100]}... ({len(assistant_message)} chars)")
            
            # Prepare timestamp
            now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            log_sheets(f"🕐 Timestamp: {now}")
            
            # Prepare function result
            function_text = "none"
            if function_result:
                try:
                    if isinstance(function_result, dict):
                        function_text = json.dumps(function_result, ensure_ascii=False)
                        log_sheets(f"🔧 Function result (dict): {function_text[:100]}...")
                    else:
                        function_text = str(function_result)
                        log_sheets(f"🔧 Function result (str): {function_text[:100]}...")
                except Exception as e:
                    log_sheets(f"⚠️ Function result formatting error: {str(e)}", "WARNING")
                    function_text = f"Error: {str(e)}"
            else:
                log_sheets("🔧 No function result")
            
            # 🆕 v2.0: Add conversation ID to data
            conversation_id_str = conversation_id or ""
            if conversation_id_str:
                log_sheets(f"🔑 Conversation ID: {conversation_id_str}")
            
            # Prepare data (5 columns now)
            values = [[now, user_message, assistant_message, function_text, conversation_id_str]]
            log_sheets(f"📋 Data prepared: {len(values[0])} columns")
            
            # Execute in thread pool
            loop = asyncio.get_event_loop()
            
            def append_values():
                try:
                    log_sheets("🚀 Starting append operation...")
                    start_time = time.time()
                    
                    # Check service account
                    if not SERVICE_ACCOUNT_INFO or "private_key" not in SERVICE_ACCOUNT_INFO:
                        log_sheets("❌ No service account data", "ERROR")
                        return False, "No service account data"
                    
                    # Get service
                    try:
                        log_sheets("🔌 Getting Sheets API service...")
                        service = GoogleSheetsService._get_sheets_service()
                        log_sheets("✅ Sheets service obtained")
                    except Exception as e:
                        log_sheets(f"❌ Failed to get Sheets service: {str(e)}", "ERROR")
                        return False, f"Service error: {str(e)}"
                    
                    body = {'values': values}
                    log_sheets(f"📦 Request body prepared")
                    
                    # Send request (updated range to A:E for 5 columns)
                    try:
                        log_sheets(f"📤 Sending append request to sheet: {sheet_id}")
                        result = service.spreadsheets().values().append(
                            spreadsheetId=sheet_id,
                            range='A:E',  # 🆕 v2.0: Changed from A:D to A:E
                            valueInputOption='RAW',
                            insertDataOption='INSERT_ROWS',
                            body=body
                        ).execute()
                        
                        elapsed = time.time() - start_time
                        log_sheets(f"✅ APPEND SUCCESSFUL (took {elapsed:.3f}s)")
                        log_sheets(f"📊 API Response: {json.dumps(result, indent=2)}")
                        
                        # Log details
                        updates = result.get('updates', {})
                        log_sheets(f"   Updated range: {updates.get('updatedRange', 'unknown')}")
                        log_sheets(f"   Updated rows: {updates.get('updatedRows', 0)}")
                        log_sheets(f"   Updated columns: {updates.get('updatedColumns', 0)}")
                        log_sheets(f"   Updated cells: {updates.get('updatedCells', 0)}")
                        
                        return True, None
                    except HttpError as http_error:
                        status_code = http_error.resp.status if hasattr(http_error, 'resp') else 'unknown'
                        error_content = http_error.content.decode('utf-8') if hasattr(http_error, 'content') else 'unknown'
                        
                        log_sheets(f"❌ HTTP ERROR {status_code}", "ERROR")
                        log_sheets(f"   Error content: {error_content}", "ERROR")
                        
                        if status_code == 403:
                            log_sheets("❌ ACCESS DENIED - Check sheet permissions", "ERROR")
                            log_sheets("   Make sure the sheet is shared with the service account email", "ERROR")
                        elif status_code == 404:
                            log_sheets("❌ SHEET NOT FOUND - Check sheet ID", "ERROR")
                        
                        return False, f"HTTP {status_code}: {str(http_error)}"
                except Exception as e:
                    log_sheets(f"❌ UNEXPECTED ERROR: {str(e)}", "ERROR")
                    log_sheets(f"Traceback: {traceback.format_exc()}", "ERROR")
                    return False, f"Error: {str(e)}"
            
            try:
                log_sheets("⏳ Executing append in thread pool...")
                success, error_message = await loop.run_in_executor(None, append_values)
                
                if success:
                    log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    log_sheets("✅ GOOGLE SHEETS LOGGING SUCCESSFUL")
                    log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    return True
                else:
                    log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "ERROR")
                    log_sheets(f"❌ GOOGLE SHEETS LOGGING FAILED", "ERROR")
                    log_sheets(f"   Error: {error_message}", "ERROR")
                    log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", "ERROR")
                    
                    # Local log as backup
                    log_sheets("💾 LOCAL BACKUP LOG:", "WARNING")
                    log_sheets(f"   User: {user_message[:100]}...", "WARNING")
                    log_sheets(f"   Assistant: {assistant_message[:100]}...", "WARNING")
                    log_sheets(f"   Function: {function_text[:100]}...", "WARNING")
                    if conversation_id_str:
                        log_sheets(f"   Conversation ID: {conversation_id_str}", "WARNING")
                    
                    return False
            except Exception as e:
                log_sheets(f"❌ Executor error: {str(e)}", "ERROR")
                log_sheets(f"Traceback: {traceback.format_exc()}", "ERROR")
                return False
                
        except Exception as e:
            log_sheets(f"❌ CRITICAL: Logging failed: {str(e)}", "ERROR")
            log_sheets(f"Traceback: {traceback.format_exc()}", "ERROR")
            return False
    
    @staticmethod
    async def verify_sheet_access(sheet_id: str) -> Dict[str, Any]:
        """Verify access to Google Sheet with detailed logging"""
        if not sheet_id:
            return {"success": False, "message": "No sheet ID provided"}
        
        try:
            log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            log_sheets("🔍 VERIFYING SHEET ACCESS")
            log_sheets(f"   Sheet ID: {sheet_id}")
            log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
            
            loop = asyncio.get_event_loop()
            
            def verify_access():
                try:
                    log_sheets("Getting Sheets service...")
                    service = GoogleSheetsService._get_sheets_service()
                    
                    log_sheets("Fetching sheet metadata...")
                    sheet = service.spreadsheets().get(
                        spreadsheetId=sheet_id,
                        fields='properties.title'
                    ).execute()
                    
                    title = sheet.get('properties', {}).get('title', 'Untitled')
                    log_sheets(f"✅ Sheet found: {title}")
                    
                    log_sheets("Testing write access...")
                    test_values = [["TEST - Access check (will be deleted)"]]
                    
                    append_result = service.spreadsheets().values().append(
                        spreadsheetId=sheet_id,
                        range='Z:Z',
                        valueInputOption='RAW',
                        insertDataOption='INSERT_ROWS',
                        body={'values': test_values}
                    ).execute()
                    
                    log_sheets("✅ Write test successful")
                    
                    update_range = append_result.get('updates', {}).get('updatedRange', 'Z1')
                    service.spreadsheets().values().clear(
                        spreadsheetId=sheet_id,
                        range=update_range,
                        body={}
                    ).execute()
                    
                    log_sheets("✅ Test data cleaned up")
                    log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    log_sheets("✅ SHEET ACCESS VERIFIED")
                    log_sheets("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
                    
                    return {
                        "success": True,
                        "message": f"Connected to: {title}. Sheet is writable.",
                        "title": title
                    }
                except HttpError as http_error:
                    status_code = http_error.resp.status if hasattr(http_error, 'resp') else 'unknown'
                    log_sheets(f"❌ HTTP Error {status_code}: {str(http_error)}", "ERROR")
                    
                    if status_code == 403:
                        return {
                            "success": False,
                            "message": "Access denied. Share the sheet with the service account."
                        }
                    elif status_code == 404:
                        return {
                            "success": False,
                            "message": "Sheet not found. Check the sheet ID."
                        }
                    else:
                        return {
                            "success": False,
                            "message": f"Error: {str(http_error)}"
                        }
                except Exception as e:
                    log_sheets(f"❌ Error: {str(e)}", "ERROR")
                    return {
                        "success": False,
                        "message": f"Error: {str(e)}"
                    }
            
            result = await loop.run_in_executor(None, verify_access)
            return result
            
        except Exception as e:
            log_sheets(f"❌ Verification failed: {str(e)}", "ERROR")
            return {
                "success": False,
                "message": f"Error: {str(e)}"
            }

    @staticmethod
    async def setup_sheet(sheet_id: str) -> bool:
        """Setup sheet headers with logging (v2.0: 5 columns)"""
        if not sheet_id:
            return False
            
        try:
            log_sheets(f"🔧 Setting up sheet: {sheet_id}")
            loop = asyncio.get_event_loop()
            
            def check_and_setup():
                try:
                    service = GoogleSheetsService._get_sheets_service()
                    
                    log_sheets("Checking for existing headers...")
                    result = service.spreadsheets().values().get(
                        spreadsheetId=sheet_id,
                        range='A1:E1'  # 🆕 v2.0: Changed from A1:D1 to A1:E1
                    ).execute()
                    
                    values = result.get('values', [])
                    
                    if not values:
                        log_sheets("Adding headers...")
                        # 🆕 v2.0: Added "Conversation ID" column
                        headers = [["Timestamp", "User", "Assistant", "Function Result", "Conversation ID"]]
                        body = {'values': headers}
                        service.spreadsheets().values().update(
                            spreadsheetId=sheet_id,
                            range='A1:E1',  # 🆕 v2.0: Changed from A1:D1 to A1:E1
                            valueInputOption='RAW',
                            body=body
                        ).execute()
                        log_sheets("✅ Headers added (5 columns)")
                    else:
                        log_sheets("✅ Headers already exist")
                        
                    return True
                except Exception as e:
                    log_sheets(f"❌ Setup error: {str(e)}", "ERROR")
                    return False
            
            result = await loop.run_in_executor(None, check_and_setup)
            return result
                
        except Exception as e:
            log_sheets(f"❌ Setup failed: {str(e)}", "ERROR")
            return False
