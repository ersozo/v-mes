# Günlük komutlar. Node.js yerelde kurulu olmasa da çalışır (Node komutları Docker içinde koşar).
NODE_RUN = docker run --rm -v "$(CURDIR)":/w -v vmes2-pnpm-store:/pnpm-store -w /w -e CI=true node:24-alpine \
	sh -c 'corepack enable >/dev/null 2>&1 && pnpm config set store-dir /pnpm-store >/dev/null && $(1)'

PY_TEST = docker run --rm -v "$(CURDIR)/apps/$(1)":/src:ro python:3.12-slim \
	sh -c 'cp -r /src /tmp/app && cd /tmp/app && pip install -q --root-user-action=ignore . pytest >/dev/null && python -m pytest -q'

.PHONY: up down logs migrate seed install test test-ts test-py build ps flows-preview flows-deploy smoke

up:            ## Tüm servisleri başlat ve migration'ları uygula
	docker compose up -d --build mssql emqx nodered
	docker compose run --rm db-migrate
	docker compose up -d --build

down:          ## Konteynerleri durdur (veriler volume'larda kalır)
	docker compose down

ps:
	docker compose ps

logs:
	docker compose logs -f --tail=100

migrate:       ## Bekleyen migration'ları uygula
	docker compose run --rm --build db-migrate

seed:          ## Migration + geliştirme verisi
	DB_SEED=1 docker compose run --rm --build db-migrate

install:
	$(call NODE_RUN,pnpm install)

test: test-ts test-py   ## Tüm birim testleri

test-ts:
	$(call NODE_RUN,pnpm install --frozen-lockfile && pnpm -r test)

test-py:
	$(call PY_TEST,simulator)
	$(call PY_TEST,api)

flows-preview: ## Node-RED akış farkını göster
	docker compose --profile tools run --rm --build flow-cli preview

flows-deploy:  ## Değişen hatları Node-RED'e deploy et
	docker compose --profile tools run --rm --build flow-cli deploy

smoke:         ## Socket.io canlı yayın duman testi (stack çalışırken)
	docker run --rm --network v-mes-2_default -v "$(CURDIR)":/w -w /w/apps/ingestion \
		-e INGESTION_URL=http://ingestion:3001 --env-file .env node:24-alpine node scripts/smoke-realtime.mjs

build:
	$(call NODE_RUN,pnpm install --frozen-lockfile && pnpm -r build)
