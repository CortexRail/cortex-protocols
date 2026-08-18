/**
 * Jest global teardown — stops the PostgreSQL container started in globalSetup.
 */

module.exports = async () => {
  if (global.__PG_CONTAINER__) {
    await global.__PG_CONTAINER__.stop();
    global.__PG_CONTAINER__ = undefined;
  }
};
