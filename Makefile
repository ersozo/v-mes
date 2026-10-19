# Günlük komutlar. Node.js yerelde kurulu olmasa da çalışır (Node komutları Docker içinde koşar).
NODE_RUN = docker run --rm -v "$(CURDIR)":/w -v vmes2-pnpm-store:/pnpm-store -w /w -e CI=true node:24-alpine \
	sh -c 'corepack enable >/dev/null 2>&1 && pnpm config set store-dir /pnpm-store >/dev/null && $(1)'

.PHONY: up down logs migrate seed install test build ps

up:            ## Altyapıyı başlat (MSSQL, EMQX, Node-RED) ve migration'ları uygula
	docker compose up -d --build mssql emqx nodered
	docker compose run --rm db-migrate

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

test:
	$(call NODE_RUN,pnpm install --frozen-lockfile && pnpm -r test)

build:
	$(call NODE_RUN,pnpm install --frozen-lockfile && pnpm -r build)
