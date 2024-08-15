#!/usr/bin/with-contenv bashio

# Variables
declare AMZ_LOGIN
declare AMZ_PASS
declare AMZ_SECRET
declare HA_WEBHOOK_URL
declare log_level
declare Amazon_Sign_in_URL
declare Amazon_Shopping_List_Page
declare DELETE_AFTER_DOWNLOAD

echo AMZ_LOGIN=$(bashio::config 'Amazon_Login')>.env
echo AMZ_PASS=$(bashio::config 'Amazon_Pass')>>.env
echo AMZ_SECRET=$(bashio::config 'Amazon_Secret')>>.env
echo HA_WEBHOOK_URL=$(bashio::config 'HA_Webhook_URL')>>.env
echo log_level=$(bashio::config 'log_level')>>.env
echo Amazon_Sign_in_URL=$(bashio::config 'Amazon_Sign_in_URL')>>.env
echo Amazon_Shopping_List_Page=$(bashio::config 'Amazon_Shopping_List_Page')>>.env
echo DELETE_AFTER_DOWNLOAD=$(bashio::config 'Delete_After_Download')>>.env

# Get the architecture information
arch=$(lscpu | grep Architecture | awk '{print $2}')

# Check if the architecture is ARM64
#if [ "$arch" == "aarch64" ]; then
#    echo "The system is running on ARM64 architecture."
#     Add your commands here
#    export PUPPETEER_EXECUTABLE_PATH='/usr/bin/firefox'
#else
#    echo "The system is not running on ARM64 architecture."
#    # Add alternative commands here
#fi


COMMANDS=(
    "cd /app/"
    "rm -rf tmp/"
    "/usr/bin/node /app/scrapeAmazon.js"
    "/usr/bin/node /app/updateHA.js"
#     "ls"
)

# Infinite loop
while true; do
  # Run each command
  for cmd in "${COMMANDS[@]}"; do
    $cmd
  done

  # Sleep for 3 minutes
  sleep 120
done
