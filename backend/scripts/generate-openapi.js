const fs = require('fs');
const swaggerJsdoc = require('swagger-jsdoc');

const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Cortex Protocol API",
      version: "0.1.0",
      description: "Intelligence Rail backend API",
    },
  },
  apis: ["./src/routes/*.js"],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

fs.writeFileSync('openapi.json', JSON.stringify(swaggerSpec, null, 2));
console.log('openapi.json generated successfully');
