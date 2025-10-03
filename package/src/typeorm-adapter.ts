import {
  type DataSource,
  type FindOptionsWhere,
  type ObjectLiteral,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Like,
  Not,
  In,
} from "typeorm";
import { BetterAuthError } from "better-auth";
import { getAuthTables, type FieldAttribute } from "better-auth/db";
import type { Adapter, BetterAuthOptions, Where } from "better-auth/types";
import * as fs from "fs";
import * as path from "path";

function withApplyDefault(
  value: unknown,
  field: FieldAttribute,
  action: "create" | "update",
): unknown {
  if (action === "update") {
    return value;
  }
  if (value === undefined || value === null) {
    if (field.defaultValue) {
      if (typeof field.defaultValue === "function") {
        return field.defaultValue();
      }
      return field.defaultValue;
    }
  }
  return value;
}

function mapFieldTypeToTypeORM(
  fieldType: string | string[],
  _: FieldAttribute,
): { type: string; length?: string } {
  const typeStr = Array.isArray(fieldType) ? fieldType[0] || "string" : fieldType;

  switch (typeStr) {
    case "string":
      return { type: "text" };
    case "number":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "date" };
    default:
      return { type: "text" };
  }
}

function generateEntity(
  modelName: string,
  modelSchema: {
    modelName: string;
    fields: Record<string, FieldAttribute>;
    disableMigrations?: boolean;
    order?: number;
  },
): string {
  const className = modelName.charAt(0).toUpperCase() + modelName.slice(1);
  const tableName = modelSchema.modelName;

  const imports = "import { Column, Entity, PrimaryColumn } from 'typeorm';\n\n";
  let entityCode = `@Entity('${tableName}')\nexport class ${className} {\n`;

  entityCode += "  @PrimaryColumn('text')\n";
  entityCode += "  id: string;\n\n";

  for (const [fieldName, field] of Object.entries(modelSchema.fields)) {
    const fieldAttr = field as FieldAttribute;
    const dbField = fieldAttr.fieldName || fieldName;
    const typeInfo = mapFieldTypeToTypeORM(fieldAttr.type, fieldAttr);

    const columnOptions: string[] = [];

    columnOptions.push(`name: '${dbField}'`);

    if (!fieldAttr.required) {
      columnOptions.push("nullable: true");
    } else {
      columnOptions.push("nullable: false");
    }

    if (fieldAttr.unique || dbField === "email" || dbField === "token") {
      columnOptions.push("unique: true");
    }

    const columnOptionsStr = columnOptions.length > 0 ? `, { ${columnOptions.join(", ")} }` : "";

    entityCode += `  @Column('${typeInfo.type}'${columnOptionsStr})\n`;
    entityCode += `  ${fieldName}: ${fieldAttr.type === "date" ? "Date" : fieldAttr.type === "boolean" ? "boolean" : "string"};\n\n`;
  }

  entityCode += "}";

  return imports + entityCode;
}

function generateMigration(
  modelName: string,
  modelSchema: {
    modelName: string;
    fields: Record<string, FieldAttribute>;
    disableMigrations?: boolean;
    order?: number;
  },
  timestamp: number,
  action: "create" | "alter",
  changes?: {
    addColumns?: { name: string; field: FieldAttribute }[];
    dropColumns?: string[];
    modifyColumns?: { name: string; field: FieldAttribute }[];
  },
): string {
  const className = `${action.charAt(0).toUpperCase() + action.slice(1)}${modelName.charAt(0).toUpperCase() + modelName.slice(1)}${timestamp}`;
  const tableName = modelSchema.modelName;

  let migrationCode =
    "import { type MigrationInterface, type QueryRunner, Table, TableIndex, TableColumn } from 'typeorm';\n\n";
  migrationCode += `export class ${className} implements MigrationInterface {\n`;
  migrationCode += "  public async up(queryRunner: QueryRunner): Promise<void> {\n";

  if (action === "create") {
    migrationCode += "    await queryRunner.createTable(\n";
    migrationCode += "      new Table({\n";
    migrationCode += `        name: '${tableName}',\n`;
    migrationCode += "        columns: [\n";

    const columns: string[] = [];
    const indexes: string[] = [];

    columns.push(`          {
            name: 'id',
            type: 'text',
            isPrimary: true,
          }`);

    for (const [fieldName, field] of Object.entries(modelSchema.fields)) {
      const fieldAttr = field as FieldAttribute;
      const dbField = fieldAttr.fieldName || fieldName;
      const typeInfo = mapFieldTypeToTypeORM(fieldAttr.type, fieldAttr);

      let columnDef = "          {\n";
      columnDef += `            name: '${dbField}',\n`;
      columnDef += `            type: '${typeInfo.type}',\n`;

      if (typeInfo.length) {
        columnDef += `            length: '${typeInfo.length}',\n`;
      }

      if (fieldName === "id" || dbField === "id") {
        continue;
      }

      if (!fieldAttr.required && fieldName !== "id") {
        columnDef += "            isNullable: true,\n";
      } else if (fieldAttr.required && fieldName !== "id") {
        columnDef += "            isNullable: false,\n";
      }

      columnDef += "          }";
      columns.push(columnDef);

      if (fieldAttr.unique || dbField === "email") {
        indexes.push(`    await queryRunner.createIndex(
      '${tableName}',
      new TableIndex({
        name: 'IDX_${tableName}_${dbField}',
        columnNames: ['${dbField}'],
        isUnique: true,
      }),
    );`);
      }
    }

    migrationCode += `${columns.join(",\n")}\n`;
    migrationCode += "        ],\n";
    migrationCode += "      }),\n";
    migrationCode += "    );\n\n";

    if (indexes.length > 0) {
      migrationCode += `${indexes.join("\n\n")}\n`;
    }
  } else if (action === "alter" && changes) {
    if (changes.addColumns) {
      for (const { name, field } of changes.addColumns) {
        const typeInfo = mapFieldTypeToTypeORM(field.type, field);
        migrationCode += `    await queryRunner.addColumn('${tableName}', new TableColumn({\n`;
        migrationCode += `      name: '${field.fieldName || name}',\n`;
        migrationCode += `      type: '${typeInfo.type}',\n`;
        migrationCode += `      isNullable: ${!field.required},\n`;
        if (field.unique) {
          migrationCode += "      isUnique: true,\n";
        }
        migrationCode += "    }));\n\n";
      }
    }

    if (changes.dropColumns) {
      for (const columnName of changes.dropColumns) {
        migrationCode += `    await queryRunner.dropColumn('${tableName}', '${columnName}');\n\n`;
      }
    }

    if (changes.modifyColumns) {
      for (const { name, field } of changes.modifyColumns) {
        const typeInfo = mapFieldTypeToTypeORM(field.type, field);
        migrationCode += `    await queryRunner.changeColumn('${tableName}', '${name}', new TableColumn({\n`;
        migrationCode += `      name: '${field.fieldName || name}',\n`;
        migrationCode += `      type: '${typeInfo.type}',\n`;
        migrationCode += `      isNullable: ${!field.required},\n`;
        if (field.unique) {
          migrationCode += "      isUnique: true,\n";
        }
        migrationCode += "    }));\n\n";
      }
    }
  }

  migrationCode += "  }\n\n";
  migrationCode += "  public async down(queryRunner: QueryRunner): Promise<void> {\n";

  if (action === "create") {
    migrationCode += `    await queryRunner.dropTable('${tableName}');\n`;
  } else if (action === "alter" && changes) {
    if (changes.addColumns) {
      for (const { name, field } of changes.addColumns) {
        migrationCode += `    await queryRunner.dropColumn('${tableName}', '${field.fieldName || name}');\n`;
      }
    }
    if (changes.dropColumns) {
      for (const columnName of changes.dropColumns) {
        migrationCode += `    await queryRunner.addColumn('${tableName}', new TableColumn({ name: '${columnName}', type: 'text', isNullable: true }));\n`;
      }
    }
  }

  migrationCode += "  }\n";
  migrationCode += "}";

  return migrationCode;
}

export const typeormAdapter =
  (dataSource: DataSource) =>
  (options: BetterAuthOptions): Adapter => {
    const schema = getAuthTables(options);

    const createTransform = () => {
      function getField(model: string, field: string): string {
        if (field === "id") {
          return field;
        }
        const modelSchema = schema[model];
        if (!modelSchema) {
          throw new Error(`Model ${model} not found in schema`);
        }
        const f = modelSchema.fields[field];
        return f.fieldName || field;
      }

      function convertOperatorToTypeORM(operator: string, value: unknown) {
        switch (operator) {
          case "eq":
            return value;
          case "ne":
            return Not(value);
          case "gt":
            return MoreThan(value);
          case "lt":
            return LessThan(value);
          case "gte":
            return MoreThanOrEqual(value);
          case "lte":
            return LessThanOrEqual(value);
          case "in":
            return In(value as unknown[]);
          case "contains":
            return Like(`%${value}%`);
          case "starts_with":
            return Like(`${value}%`);
          case "ends_with":
            return Like(`%${value}`);
          default:
            return value;
        }
      }

      function convertWhereToFindOptions(
        model: string,
        where?: Where[],
      ): FindOptionsWhere<ObjectLiteral> {
        if (!where || where.length === 0) return {};

        const findOptions: FindOptionsWhere<ObjectLiteral> = {};

        for (const w of where) {
          const field = getField(model, w.field);

          if (!w.operator || w.operator === "eq") {
            findOptions[field] = w.value;
          } else {
            findOptions[field] = convertOperatorToTypeORM(w.operator, w.value);
          }
        }

        return findOptions;
      }

      function getModelName(model: string): string {
        const modelSchema = schema[model];
        if (!modelSchema) {
          throw new Error(`Model ${model} not found in schema`);
        }
        return modelSchema.modelName;
      }

      const useDatabaseGeneratedId = options?.advanced?.generateId === false;

      return {
        transformInput(
          data: Record<string, unknown>,
          model: string,
          action: "create" | "update",
        ): Record<string, unknown> {
          const transformedData: Record<string, unknown> =
            useDatabaseGeneratedId || action === "update"
              ? {}
              : {
                  id: data.id,
                };

          const modelSchema = schema[model];
          if (!modelSchema) {
            throw new Error(`Model ${model} not found in schema`);
          }

          const fields = modelSchema.fields;
          for (const field in fields) {
            const value = data[field];
            if (value === undefined && (!fields[field].defaultValue || action === "update")) {
              continue;
            }
            transformedData[fields[field].fieldName || field] = withApplyDefault(
              value,
              fields[field],
              action,
            );
          }
          return transformedData;
        },

        transformOutput(
          data: ObjectLiteral | null,
          model: string,
          select: string[] = [],
        ): Record<string, unknown> | null {
          if (!data) return null;

          const transformedData: Record<string, unknown> =
            data.id || data._id
              ? select.length === 0 || select.includes("id")
                ? { id: data.id || data._id }
                : {}
              : {};

          const modelSchema = schema[model];
          if (!modelSchema) {
            throw new Error(`Model ${model} not found in schema`);
          }

          const tableSchema = modelSchema.fields;
          for (const key in tableSchema) {
            if (select.length && !select.includes(key)) {
              continue;
            }
            const field = tableSchema[key];
            if (field) {
              transformedData[key] = data[field.fieldName || key];
            }
          }
          return transformedData;
        },

        convertWhereToFindOptions,
        getModelName,
        getField,
      };
    };

    const { transformInput, transformOutput, convertWhereToFindOptions, getModelName } =
      createTransform();

    return {
      id: "typeorm",
      async create<T extends Record<string, unknown>, R = T>(data: {
        model: string;
        data: T;
        select?: string[];
      }): Promise<R> {
        const { model, data: values, select } = data;
        const transformed = transformInput(values, model, "create");

        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const entity = repository.create(transformed);
          const result = await repository.save(entity);
          return transformOutput(result, model, select) as R;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to create ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async update<T>(data: {
        model: string;
        where: Where[];
        update: Record<string, unknown>;
        select?: string[];
      }): Promise<T | null> {
        const { model, where, update, select = [] } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          const transformed = transformInput(update, model, "update");

          if (where.length === 1) {
            const updatedRecord = await repository.findOne({
              where: findOptions,
            });

            if (updatedRecord) {
              await repository.update(findOptions, transformed);
              const result = await repository.findOne({
                where: findOptions,
              });
              return transformOutput(result, model, select) as T;
            }
          }

          await repository.update(findOptions, transformed);
          return null;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to update ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async delete(data: { model: string; where: Where[] }): Promise<void> {
        const { model, where } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          await repository.delete(findOptions);
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to delete ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async findOne<T>(data: {
        model: string;
        where: Where[];
        select?: string[];
      }): Promise<T | null> {
        const { model, where, select } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          const result = await repository.findOne({
            where: findOptions,
            select: select,
          });
          return transformOutput(result, model, select) as T;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to find ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async findMany<T>(data: {
        model: string;
        where?: Where[];
        limit?: number;
        offset?: number;
        sortBy?: { field: string; direction: "asc" | "desc" };
      }): Promise<T[]> {
        const { model, where, limit, offset, sortBy } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);

          const result = await repository.find({
            where: findOptions,
            take: limit || 100,
            skip: offset || 0,
            order: sortBy?.field
              ? {
                  [sortBy.field]: sortBy.direction === "desc" ? "DESC" : "ASC",
                }
              : undefined,
          });

          return result.map((r) => transformOutput(r, model)) as T[];
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to find many ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async count(data) {
        const { model, where } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          const result = await repository.count({ where: findOptions });
          return result;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to count ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async updateMany(data) {
        const { model, where, update } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          const transformed = transformInput(update, model, "update");

          const result = await repository.update(findOptions, transformed);
          return result.affected || 0;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to update many ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async deleteMany(data) {
        const { model, where } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          const result = await repository.delete(findOptions);
          return result.affected || 0;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to delete many ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async createSchema(_, file) {
        try {
          const metadata = dataSource.entityMetadatas;
          const existingTableNames = metadata.map((meta) => meta.tableName);
          const existingTables = new Map();

          for (const meta of metadata) {
            const columns = meta.columns.map((col) => ({
              name: col.databaseName,
              type: col.type,
              isNullable: col.isNullable,
              isUnique: col.entityMetadata.uniques.some((u) =>
                u.columns.some((c) => c.propertyName === col.propertyName),
              ),
            }));
            existingTables.set(meta.tableName, columns);
          }

          const expectedTables = Object.keys(schema);
          const missingTables = expectedTables.filter(
            (model) => !existingTableNames.includes(schema[model].modelName),
          );

          const tablesToUpdate = expectedTables.filter((model) =>
            existingTableNames.includes(schema[model].modelName),
          );

          const timestamp = Date.now();
          const typeormDir = path.resolve("./typeorm");
          const migrationsDir = path.resolve("./typeorm/migrations");
          const entitiesDir = path.resolve("./typeorm/entities");

          if (!fs.existsSync(typeormDir)) {
            fs.mkdirSync(typeormDir, { recursive: true });
          }
          if (!fs.existsSync(migrationsDir)) {
            fs.mkdirSync(migrationsDir, { recursive: true });
          }
          if (!fs.existsSync(entitiesDir)) {
            fs.mkdirSync(entitiesDir, { recursive: true });
          }

          let changelogContent = `# TypeORM Schema Changes - ${new Date().toISOString()}\n\n`;

          if (missingTables.length === 0 && tablesToUpdate.length === 0) {
            return {
              code: "No pending migrations found.",
              path: file ?? "typeorm/changelog.txt",
            };
          }

          for (const modelName of missingTables) {
            const modelSchema = schema[modelName];

            const migrationCode = generateMigration(modelName, modelSchema, timestamp, "create");
            const migrationPath = path.join(migrationsDir, `${timestamp}-create-${modelName}.ts`);
            fs.writeFileSync(migrationPath, migrationCode);

            const entityCode = generateEntity(modelName, modelSchema);
            const entityPath = path.join(
              entitiesDir,
              `${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts`,
            );
            fs.writeFileSync(entityPath, entityCode);

            changelogContent += `- CREATE Migration: migrations/${timestamp}-create-${modelName}.ts\n`;
            changelogContent += `- Entity: entities/${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts\n\n`;
          }

          for (const modelName of tablesToUpdate) {
            const modelSchema = schema[modelName];
            const tableName = modelSchema.modelName;
            const existingColumns = existingTables.get(tableName) || [];

            const expectedFields = modelSchema.fields;
            const existingColumnNames = existingColumns.map(
              (col: {
                name: string;
              }) => col.name,
            );

            const addColumns = [];
            const dropColumns = [];
            const modifyColumns: { name: string; field: FieldAttribute }[] = [];

            for (const [fieldName, field] of Object.entries(expectedFields)) {
              const dbField = field.fieldName || fieldName;
              if (!existingColumnNames.includes(dbField)) {
                addColumns.push({ name: fieldName, field });
              }
            }

            for (const existingCol of existingColumns) {
              const fieldExists = Object.entries(expectedFields).some(
                ([fieldName, field]) => (field.fieldName || fieldName) === existingCol.name,
              );
              if (!fieldExists && existingCol.name !== "id") {
                dropColumns.push(existingCol.name);
              }
            }

            if (addColumns.length > 0 || dropColumns.length > 0 || modifyColumns.length > 0) {
              const changes = { addColumns, dropColumns, modifyColumns };
              const migrationCode = generateMigration(
                modelName,
                modelSchema,
                timestamp,
                "alter",
                changes,
              );
              const migrationPath = path.join(migrationsDir, `${timestamp}-alter-${modelName}.ts`);
              fs.writeFileSync(migrationPath, migrationCode);

              const entityCode = generateEntity(modelName, modelSchema);
              const entityPath = path.join(
                entitiesDir,
                `${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts`,
              );
              fs.writeFileSync(entityPath, entityCode);

              changelogContent += `- ALTER Migration: migrations/${timestamp}-alter-${modelName}.ts\n`;
              changelogContent += `- Updated Entity: entities/${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts\n`;

              if (addColumns.length > 0) {
                changelogContent += `  - Added columns: ${addColumns.map((col) => col.field.fieldName || col.name).join(", ")}\n`;
              }
              if (dropColumns.length > 0) {
                changelogContent += `  - Removed columns: ${dropColumns.join(", ")}\n`;
              }
              changelogContent += "\n";
            }
          }

          if (missingTables.length > 0) {
            changelogContent += `\nTables to create: ${missingTables.map((t) => schema[t].modelName).join(", ")}\n`;
          }

          return {
            code: changelogContent,
            path: file ?? "typeorm/changelog.txt",
          };
        } catch (error) {
          throw new BetterAuthError(
            `Failed to create schema: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    };
  };
