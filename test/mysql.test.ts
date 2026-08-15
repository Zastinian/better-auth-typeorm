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

const typeormOutputDir = path.join(__dirname, "typeorm/mysql");

const dataSource = new DataSource({
  type: "mysql",
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  username: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "root",
  database: process.env.MYSQL_DATABASE ?? "better_auth_test",
  entities: [path.join(typeormOutputDir, "entities/**/*.ts")],
  synchronize: true,
  logging: false,
});

const { execute } = await testAdapter({
  adapter: () =>
    typeormAdapter(dataSource, {
      outputDir: typeormOutputDir,
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
