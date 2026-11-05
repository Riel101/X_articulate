# X_articulate

An experimental LangChain agent for drafting viral X (Twitter) posts.

The agent uses an NVIDIA Nemotron model through `langchain-nvidia-ai-endpoints`
and has a Tavily-powered web search tool for pulling in current information.
Writing rules and virality constraints live in [`GUIDELINES.md`](GUIDELINES.md).

## Project structure

```
.
├── articulate_agent.py   # Agent setup: model, tools, system prompt
├── GUIDELINES.md         # Rules for writing viral X posts
├── requirements.txt
└── .env.example          # Required environment variables
```

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# then add your NVIDIA and Tavily API keys to .env
```

### Environment variables

| Variable         | Purpose                                        |
| ---------------- | ---------------------------------------------- |
| `NVIDIA_API_KEY` | Auth for the NVIDIA-hosted Nemotron model      |
| `TAVILY_API_KEY` | Auth for Tavily web search                     |

## Usage

```bash
python articulate_agent.py
```

`articulate_agent.py` currently defines the model, the `web_search` tool, and
the agent itself. `download_img` is a placeholder and is not registered with
the agent yet.

## Notes

- `.env` and `venv/` are git-ignored — never commit real API keys.
- The system prompt is intentionally empty; fill it in with the voice and
  instructions you want the agent to follow.
