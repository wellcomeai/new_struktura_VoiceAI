"""
Data processing functions for WellcomeAI application.
Contains functions for processing data.
"""

import json
from typing import Dict, Any, List, Optional
from .registry import register_function

@register_function(
    func_id="format_json",
    description="Форматировать JSON данные",
    parameters={
        "type": "object",
        "properties": {
            "data": {
                "type": "string",
                "description": "JSON данные в строковом формате"
            }
        },
        "required": ["data"]
    }
)
async def format_json(data: str) -> Dict[str, Any]:
    """
    Format JSON data
    
    Args:
        data: JSON data as string
    
    Returns:
        Formatted data
    """
    try:
        # Parse JSON
        parsed_data = json.loads(data)
        
        # Format JSON with indentation
        formatted_json = json.dumps(parsed_data, indent=2, ensure_ascii=False)
        
        return {
            "success": True,
            "formatted_data": formatted_json
        }
    except json.JSONDecodeError as e:
        return {
            "success": False,
            "error": f"Ошибка парсинга JSON: {str(e)}"
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

@register_function(
    func_id="analyze_text",
    description="Анализировать текст",
    parameters={
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "Текст для анализа"
            }
        },
        "required": ["text"]
    }
)
async def analyze_text(text: str) -> Dict[str, Any]:
    """
    Analyze text data
    
    Args:
        text: Text to analyze
    
    Returns:
        Analysis results
    """
    try:
        # Simple text analysis
        word_count = len(text.split())
        char_count = len(text)
        
        return {
            "success": True,
            "word_count": word_count,
            "character_count": char_count,
            "snippet": text[:100] + "..." if len(text) > 100 else text
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }
