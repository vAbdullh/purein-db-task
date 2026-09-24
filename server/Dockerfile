FROM node:18

WORKDIR /usr/src/app

# Copy package files and install dependencies
COPY server/package*.json ./
RUN npm install

# Copy the Prisma schema and generate the client
# (Doing this before copying the rest of the code optimizes caching)
COPY server/prisma ./prisma
RUN npx prisma generate

# Copy the rest of the application code
COPY server/ .

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
