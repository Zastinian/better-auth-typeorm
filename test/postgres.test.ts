import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  normalTestSuite,
  testAdapter,
  transactionsTestSuite,
  uuidTestSuite,
} from "@better-auth/test-utils/adapter";
import path from "path";
import { DataSource } from "typeorm";
import { typeormAdapter } from "../package/src";

const dataSource = new DataSource({
  type: "postgres",
  host: process.env.POSTGRES_HOST ?? "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? "postgres",
  password: process.env.POSTGRES_PASSWORD ?? "postgres",
  database: process.env.POSTGRES_DATABASE ?? "better_auth_test",
  entities: [path.join(__dirname, "typeorm/entities/**/*.ts")],
  synchronize: true,
  logging: false,
});

const { execute } = await testAdapter({
  adapter: () =>
    typeormAdapter(dataSource, {
      debugLogs: false,
      enableSchemaSync: true,
    }),
  runMigrations: async () => {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
  },
  tests: [
    normalTestSuite({
      disableTests: {
        "findOne - should find a model with modified field name": true,
        "findOne - should join a model with modified field name": true,
        "findMany - should select fields": true,
      },
    }),
    caseInsensitiveTestSuite(),
    transactionsTestSuite({ disableTests: { ALL: true } }),
    authFlowTestSuite(),
    uuidTestSuite({
      disableTests: {
        "findOne - should find a model with modified field name": true,
        "findOne - should join a model with modified field name": true,
        "findMany - should select fields": true,
      },
    }),
  ],
  async onFinish() {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  },
});

execute();
