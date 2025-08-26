<div align="center">
  <p>
    <strong>📦 @hedystia/better-auth-typeorm</strong>
  </p>

  <p>
    <strong>TypeORM adapter for Better Auth - Powerful database integration for your auth system! 🚀</strong>
  </p>

  <p>
    <a href="https://www.npmjs.com/package/@hedystia/better-auth-typeorm"><img src="https://img.shields.io/npm/v/@hedystia/better-auth-typeorm.svg?style=flat-square" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/@hedystia/better-auth-typeorm"><img src="https://img.shields.io/npm/dm/@hedystia/better-auth-typeorm.svg?style=flat-square" alt="npm downloads"></a>
    <a href="https://github.com/Zastinian/better-auth-typeorm/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Zastinian/better-auth-typeorm.svg?style=flat-square" alt="license"></a>
  </p>
</div>

## 🌟 Features

- 🗄️ **Database Agnostic**: Works with all TypeORM-supported databases (MySQL, PostgreSQL, SQLite, etc.)
- 🔄 **CRUD Operations**: Full support for create, read, update, and delete operations
- ⚡ **Efficient Queries**: Built-in pagination, sorting, and filtering support
- 🔒 **Secure Operations**: Proper transaction handling and error management

## 🚀 Quick Start

1. Install the package:

```bash
npm install @hedystia/better-auth-typeorm typeorm
```

2.  **Generate TypeORM Entities and Migrations**

Before you can use the adapter, you need to generate the necessary entities and migrations for your database. You can do this using the Better Auth CLI:

```bash
bunx @better-auth/cli generate
# or
npx @better-auth/cli generate
```

This command will create the `typeorm/entities` and `typeorm/migrations` directories in your project.

3.  Create your TypeORM DataSource configuration:

```typescript
import { DataSource } from "typeorm";
import path from "path";

export const dataSource = new DataSource({
  type: "mysql",
  host: "localhost",
  port: 3306,
  username: "your_username",
  password: "your_password",
  database: "your_database",
  entities: [path.join(__dirname, "typeorm/entities/**/*.ts")],
  migrations: [path.join(__dirname, "typeorm/migrations/**/*.ts")],
  migrationsRun: true,
});

await dataSource.initialize();
```

4. Set up your Better Auth configuration:

```typescript
import { betterAuth } from "better-auth";
import { typeormAdapter } from "@hedystia/better-auth-typeorm";
import { organization, twoFactor } from "better-auth/plugins";
import { dataSource } from "./data-source";

export const auth = betterAuth({
  database: typeormAdapter(dataSource),
  plugins: [organization(), twoFactor()],
});
```

## 🌟 Why use this adapter?

- **Seamless Integration**: Direct mapping between Better Auth entities and TypeORM
- **Flexible Database Support**: Use with any TypeORM-supported database
- **Production Ready**: Built-in error handling and transaction support
- **Performance Optimized**: Efficient query building and data transformation

## 📝 License

This project is licensed under the [MIT License](LICENSE).

## 🙏 Acknowledgements

- [TypeORM](https://typeorm.io/)
- [Better Auth](https://github.com/better-auth/better-auth)
