import os
from dotenv import load_dotenv
from tavily import TavilyClient
from langchain.agents import create_agent
from langchain.tools import tool
from langchain_nvidia_ai_endpoints import ChatNVIDIA

load_dotenv()

client = ChatNVIDIA(
  model="nvidia/nemotron-3-ultra-550b-a55b",
  api_key=os.getenv("NVIDIA_API_KEY"), 
  temperature=1,
  top_p=0.95,
  max_completion_tokens=10000,
)

@tool
def web_search(query: str) -> str:
  """Search the web with the query"""
  return TavilyClient(os.getenv("TAVILY_API_KEY")).search(query)

@tool
def download_img(filename: str, url: str):
  
  return

model = create_agent(
  model=client,
  tools=[web_search, ],
  system_prompt="""""",
)

