#!/bin/sh
# Смоук-тест собранного образа: весь путь покупки, включая настоящий HTTP-вебхук от учебного шлюза.
set -eu
API="${1:-http://localhost:3000}"
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log($1)})"; }

curl -sf "$API/health" > /dev/null
TOKEN=$(curl -sf "$API/auth/login" -H 'content-type: application/json' \
  -d '{"email":"buyer@kassa.kz","password":"kassa-demo"}' | json 'v.access_token')
EVENT=$(curl -sf "$API/events?limit=1" | json 'v.items[0].id')
SEAT=$(curl -sf "$API/events/$EVENT" | json 'v.seats.find(s => s.status === "free").id')

curl -sf "$API/events/$EVENT/holds" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"seat_ids\":[$SEAT]}" > /dev/null
ORDER=$(curl -sf "$API/orders" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: smoke-test-key' -d "{\"event_id\":$EVENT,\"seat_ids\":[$SEAT]}" | json 'v.id')
curl -sf "$API/orders/$ORDER/pay" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"card_token":"tok_success"}' > /dev/null

for i in $(seq 1 20); do
  STATUS=$(curl -sf "$API/orders/$ORDER" -H "authorization: Bearer $TOKEN" | json 'v.status')
  [ "$STATUS" = "paid" ] && echo "Смоук пройден: заказ $ORDER оплачен" && exit 0
  sleep 0.5
done
echo "Заказ не оплачен: $STATUS" && exit 1
