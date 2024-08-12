ARG BUILD_FROM
FROM ${BUILD_FROM}
USER root

# Set environment variables to non-interactive
ENV DEBIAN_FRONTEND=noninteractive

# Install required packages
RUN apt-get update && apt-get install -y sudo curl && \
    curl -fsSL https://deb.nodesource.com/setup_21.x | sudo -E bash - && \
    apt-get install -y nodejs

# Install Google Chrome
RUN sudo apt install curl gnupg -y
RUN curl --location --silent https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo apt-key add
RUN sudo sh -c 'echo "deb http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list'
RUN sudo apt update
RUN sudo apt install -y google-chrome-stable --no-install-recommends
RUN sudo rm -rf /var/lib/apt/lists/*

# Install Firefox
RUN sudo sh -c 'echo "deb http://deb.debian.org/debian/ unstable main contrib non-free" >> /etc/apt/sources.list.d/debian.list'
RUN sudo apt update && sudo apt install -y firefox --no-install-recommends

WORKDIR /app
COPY rootfs /
#COPY rootfs .

# Install necessary npm packages
RUN npm install puppeteer otpauth dotenv
RUN chmod a+x /app/script.sh

# Start script
CMD [ "/app/script.sh" ]
