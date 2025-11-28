FROM node:18-alpine

WORKDIR /usr/src/app

# Instala apenas dependências em produção
COPY package.json ./
RUN npm install --only=production

# Copia o código da aplicação
COPY app ./app

# Garante que o diretório de dados exista
RUN mkdir -p app/backend/data/rooms

EXPOSE 3000

CMD ["npm", "start"]


