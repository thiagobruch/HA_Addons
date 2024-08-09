#!/usr/bin/with-contenv bashio

######/bin/bash
######/command/with-contenv bashio
######/usr/bin/with-contenv bashio
# Define the commands to run

declare AMZ_LOGIN
declare AMZ_PASS
declare AMZ_SECRET
declare HA_WEBHOOK_URL

echo AMZ_LOGIN=$(bashio::config 'Amazon_Login')>.env
echo AMZ_PASS=$(bashio::config 'Amazon_Pass')>>.env
echo AMZ_SECRET=$(bashio::config 'Amazon_Secret')>>.env
echo HA_WEBHOOK_URL=$(bashio::config 'HA_Webhook_URL')>>.env

COMMANDS=(
    "cd /app/"
    "rm -rf tmp/"
    "/usr/bin/node /app/scrapeAmazon.js"
    "/usr/bin/node /app/updateHA.js"
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
