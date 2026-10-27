.PHONY: up down logs migrate seed dev test check
up:
	docker compose up --build -d
down:
	docker compose down
logs:
	docker compose logs -f api
migrate:
	npm run db:deploy
seed:
	npm run db:seed
dev:
	npm run dev
test:
	npm test
check:
	npm run typecheck && npm test
