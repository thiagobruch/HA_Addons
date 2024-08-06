#!/usr/bin/with-contenv bashio
# Define the commands to run
COMMANDS=(
    "cd /usr/src/app/"
	export AMZ_LOGIN=$(bashio::config 'Amazon_Login')
	export AMZ_PASS=$(bashio::config 'Amazon_Pass')
	export AMZ_SECRET=$(bashio::config 'Amazon_Secret')
	export HA_WEBHOOK_URL=$(bashio::config 'HA_Webhook_URL')
    "/usr/bin/node /usr/src/app/scrapeAmazon.js"
    "/usr/bin/node /usr/src/app/updateHA.js"
    "/usr/bin/date"
	export AMZ_LOGIN=
	export AMZ_PASS=
	export AMZ_SECRET=
	export HA_WEBHOOK_URL=
)

# Infinite loop
while true; do
  # Run each command
  for cmd in "${COMMANDS[@]}"; do
    $cmd
  done

  # Sleep for 3 minutes
  sleep 180
done
