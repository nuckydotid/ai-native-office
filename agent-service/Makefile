PY ?= .venv/bin/python
PORT ?= 8090

.PHONY: install dev test eval

install:
	python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"

# Offline: fake model, in-memory index pre-loaded from the fixtures, no auth. Try:
#   curl -N -X POST localhost:8090/v1/run -H 'content-type: application/json' -d @eval/fixtures/run-example.json
dev:
	MODEL_BACKEND=fake KNOWLEDGE_BACKEND=memory AUTH_MODE=none SEED_DIR=eval/fixtures \
	$(PY) -m uvicorn agent_service.main:app_factory --factory --host 0.0.0.0 --port $(PORT) --reload

test:
	MODEL_BACKEND=fake KNOWLEDGE_BACKEND=memory AUTH_MODE=none $(PY) -m pytest -q

# Real run (needs ADC and a Vertex-enabled project): MODEL_BACKEND=vertex make eval
eval:
	$(PY) eval/run_eval.py
