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

if [ "$(bashio::config 'log_level')" == "true" ]; then
        apk add mini_httpd
        mkdir /app/www
        echo port=8888  >> /etc/mini_httpd/mini_httpd.conf
        echo user=minihttpd   >> /etc/mini_httpd/mini_httpd.conf
        echo dir=/app/www  >> /etc/mini_httpd/mini_httpd.conf
        echo nochroot  >> /etc/mini_httpd/mini_httpd.conf
        apk add openrc  --no-cache
        mkdir -p /run/openrc/exclusive
        touch /run/openrc/softlevel
        rc-service mini_httpd start
fi

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
  sleep 180
done
