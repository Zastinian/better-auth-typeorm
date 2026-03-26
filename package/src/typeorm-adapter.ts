import { BetterAuthError } from "better-auth";
import { type CleanedWhere, createAdapterFactory } from "better-auth/adapters";
import type { Where } from "better-auth/types";
import * as fs from "fs";
import * as path from "path";
import {
  DataSource,
  type DeleteResult,
  type FindOptionsWhere,
  In,
  LessThan,
  LessThanOrEqual,
  Like,
  MoreThan,
  MoreThanOrEqual,
  Not,
  type ObjectLiteral,
  type Repository,
  type UpdateResult,
} from "typeorm";

function tryGetRepository(
  dataSource: DataSource,
  tableName: string,
  requiredFields?: string[],
): Repository<ObjectLiteral> | null {
  try {
    const metadata = dataSource.entityMetadatas.find(
      (meta) =>
        meta.tableName === tableName || meta.name === tableName || meta.targetName === tableName,
    );
    if (!metadata) {
      return null;
    }
    if (requiredFields) {
      for (const field of requiredFields) {
        const hasColumn = metadata.columns.some(
          (col) => col.propertyName === field || col.databaseName === field,
        );
        if (!hasColumn) {
          return null;
        }
      }
    }
    return dataSource.getRepository(tableName);
  } catch {
    return null;
  }
}

function escapeId(dataSource: DataSource, name: string): string {
  return dataSource.driver.escape(name);
}

async function ensureTableExists(
  dataSource: DataSource,
  tableName: string,
  data: Record<string, unknown>,
): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    const tableExists = await queryRunner.hasTable(tableName);
    if (!tableExists) {
      const columns = Object.entries(data)
        .map(([key, value]) => {
          const escaped = escapeId(dataSource, key);
          if (key === "id") {
            return `${escaped} text PRIMARY KEY`;
          }
          const type =
            typeof value === "boolean"
              ? "boolean"
              : typeof value === "number"
                ? "integer"
                : value instanceof Date
                  ? "datetime"
                  : "text";
          return `${escaped} ${type}`;
        })
        .join(", ");
      await queryRunner.query(
        `CREATE TABLE IF NOT EXISTS ${escapeId(dataSource, tableName)} (${columns})`,
      );
    } else {
      const table = await queryRunner.getTable(tableName);
      if (table) {
        const existingColumns = new Set(table.columns.map((col) => col.name));
        for (const [key, value] of Object.entries(data)) {
          if (!existingColumns.has(key)) {
            const type =
              typeof value === "boolean"
                ? "boolean"
                : typeof value === "number"
                  ? "integer"
                  : value instanceof Date
                    ? "datetime"
                    : "text";
            await queryRunner.query(
              `ALTER TABLE ${escapeId(dataSource, tableName)} ADD COLUMN ${escapeId(dataSource, key)} ${type}`,
            );
          }
        }
      }
    }
  } finally {
    await queryRunner.release();
  }
}

type FieldAttribute = {
  type: string | string[];
  required?: boolean;
  unique?: boolean;
  index?: boolean;
  bigint?: boolean;
  fieldName?: string;
  defaultValue?: unknown | (() => unknown);
  onUpdate?: () => unknown;
  references?: {
    model: string;
    field: string;
    onDelete?: "no action" | "restrict" | "cascade" | "set null" | "set default";
  };
};

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function toRelationPropertyName(fieldName: string): string {
  if (fieldName.endsWith("Id") && fieldName.length > 2) {
    return fieldName.slice(0, -2);
  }
  return `${fieldName}Relation`;
}

function getDateColumnType(dataSource: DataSource): string {
  switch (dataSource.options.type) {
    case "postgres":
    case "cockroachdb":
      return "timestamptz";
    case "mssql":
      return "datetime2";
    case "mysql":
    case "mariadb":
    case "better-sqlite3":
    case "sqlite":
    case "sqljs":
    case "capacitor":
    case "cordova":
    case "expo":
    case "react-native":
      return "datetime";
    default:
      return "timestamp";
  }
}

function mapFieldTypeToTypeORM(
  fieldType: string | string[],
  field: FieldAttribute,
  dataSource: DataSource,
): { type: string; length?: string } {
  const typeStr = Array.isArray(fieldType) ? fieldType[0] || "string" : fieldType;

  switch (typeStr) {
    case "string":
      return { type: "text" };
    case "number":
      return { type: field.bigint ? "bigint" : "integer" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: getDateColumnType(dataSource) };
    default:
      return { type: "text" };
  }
}

function formatDefaultValueForEntity(field: FieldAttribute): string | null {
  if (field.defaultValue === undefined) {
    return null;
  }

  if (typeof field.defaultValue === "function") {
    if ((Array.isArray(field.type) ? field.type[0] : field.type) === "date") {
      return "default: () => 'CURRENT_TIMESTAMP'";
    }
    return null;
  }

  if (typeof field.defaultValue === "string") {
    return `default: ${JSON.stringify(field.defaultValue)}`;
  }

  if (typeof field.defaultValue === "number" || typeof field.defaultValue === "boolean") {
    return `default: ${String(field.defaultValue)}`;
  }

  return null;
}

function formatDefaultValueForMigration(field: FieldAttribute): string | null {
  if (field.defaultValue === undefined) {
    return null;
  }

  if (typeof field.defaultValue === "function") {
    if ((Array.isArray(field.type) ? field.type[0] : field.type) === "date") {
      return JSON.stringify("CURRENT_TIMESTAMP");
    }
    return null;
  }

  if (typeof field.defaultValue === "string") {
    return JSON.stringify(`'${field.defaultValue}'`);
  }

  if (typeof field.defaultValue === "number" || typeof field.defaultValue === "boolean") {
    return JSON.stringify(field.defaultValue);
  }

  return null;
}

function convertOperatorToTypeORM(operator: Where["operator"], value: unknown) {
  switch (operator) {
    case "ne":
      return Not(value);
    case "lt":
      return LessThan(value);
    case "lte":
      return LessThanOrEqual(value);
    case "gt":
      return MoreThan(value);
    case "gte":
      return MoreThanOrEqual(value);
    case "in":
      return In(value as unknown[]);
    case "not_in":
      return Not(In(value as unknown[]));
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

function generateEntity(
  dataSource: DataSource,
  modelName: string,
  modelSchema: {
    modelName: string;
    fields: Record<string, FieldAttribute>;
    disableMigrations?: boolean;
    order?: number;
  },
): string {
  const className = toPascalCase(modelName);
  const tableName = modelSchema.modelName;
  const referencedModels = new Set<string>();
  const typeormImports = new Set(["Column", "Entity", "Index", "PrimaryColumn"]);

  for (const field of Object.values(modelSchema.fields)) {
    if (field.references) {
      referencedModels.add(field.references.model);
      typeormImports.add("JoinColumn");
      typeormImports.add("ManyToOne");
    }
  }

  const imports = [`import { ${Array.from(typeormImports).sort().join(", ")} } from 'typeorm';`];
  for (const referencedModel of Array.from(referencedModels).sort()) {
    imports.push(
      `import { ${toPascalCase(referencedModel)} } from './${toPascalCase(referencedModel)}';`,
    );
  }
  imports.push("");
  let entityCode = `@Entity('${tableName}')\nexport class ${className} {\n`;

  entityCode += "  @PrimaryColumn('text')\n";
  entityCode += "  id!: string;\n\n";

  for (const [fieldName, field] of Object.entries(modelSchema.fields)) {
    const fieldAttr = field as FieldAttribute;
    const dbField = fieldAttr.fieldName || fieldName;
    const typeInfo = mapFieldTypeToTypeORM(fieldAttr.type, fieldAttr, dataSource);

    const columnOptions: string[] = [];

    columnOptions.push(`name: '${dbField}'`);

    if (!fieldAttr.required) {
      columnOptions.push("nullable: true");
    }

    if (fieldAttr.unique || dbField === "email" || dbField === "token") {
      columnOptions.push("unique: true");
    }

    const defaultValue = formatDefaultValueForEntity(fieldAttr);
    if (defaultValue) {
      columnOptions.push(defaultValue);
    }

    const columnOptionsStr = columnOptions.length > 0 ? `, { ${columnOptions.join(", ")} }` : "";

    if (fieldAttr.index) {
      entityCode += `  @Index('${tableName}_${dbField}_idx')\n`;
    }

    entityCode += `  @Column('${typeInfo.type}'${columnOptionsStr})\n`;
    const tsType =
      fieldAttr.type === "date"
        ? "Date"
        : fieldAttr.type === "boolean"
          ? "boolean"
          : fieldAttr.type === "number"
            ? "number"
            : "string";
    const nullableModifier = fieldAttr.required ? "!" : "";
    const nullableType = fieldAttr.required ? "" : " | null";
    entityCode += `  ${fieldName}${nullableModifier}: ${tsType}${nullableType};\n\n`;

    if (fieldAttr.references) {
      const relationClass = toPascalCase(fieldAttr.references.model);
      const relationPropertyName = toRelationPropertyName(fieldName);
      entityCode += `  @ManyToOne(() => ${relationClass}, { onDelete: '${(fieldAttr.references.onDelete || "cascade").toUpperCase()}', nullable: ${fieldAttr.required ? "false" : "true"} })\n`;
      entityCode += `  @JoinColumn({ name: '${dbField}', referencedColumnName: '${fieldAttr.references.field}' })\n`;
      entityCode += `  ${relationPropertyName}${fieldAttr.required ? "!" : "?"}: ${relationClass};\n\n`;
    }
  }

  entityCode += "}";

  return `${imports.join("\n")}\n${entityCode}`;
}

function generateMigration(
  dataSource: DataSource,
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
  const className = `${action.charAt(0).toUpperCase() + action.slice(1)}${toPascalCase(modelName)}${timestamp}`;
  const tableName = modelSchema.modelName;

  let migrationCode =
    "import { type MigrationInterface, type QueryRunner, Table, TableColumn, TableForeignKey, TableIndex } from 'typeorm';\n\n";
  migrationCode += `export class ${className} implements MigrationInterface {\n`;
  migrationCode += "  public async up(queryRunner: QueryRunner): Promise<void> {\n";

  if (action === "create") {
    migrationCode += "    await queryRunner.createTable(\n";
    migrationCode += "      new Table({\n";
    migrationCode += `        name: '${tableName}',\n`;
    migrationCode += "        columns: [\n";

    const columns: string[] = [];
    const postCreateStatements: string[] = [];

    columns.push(`          {
            name: 'id',
            type: 'text',
            isPrimary: true,
          }`);

    for (const [fieldName, field] of Object.entries(modelSchema.fields)) {
      const fieldAttr = field as FieldAttribute;
      const dbField = fieldAttr.fieldName || fieldName;
      const typeInfo = mapFieldTypeToTypeORM(fieldAttr.type, fieldAttr, dataSource);

      if (fieldName === "id" || dbField === "id") {
        continue;
      }

      let columnDef = "          {\n";
      columnDef += `            name: '${dbField}',\n`;
      columnDef += `            type: '${typeInfo.type}',\n`;

      if (typeInfo.length) {
        columnDef += `            length: '${typeInfo.length}',\n`;
      }

      if (!fieldAttr.required) {
        columnDef += "            isNullable: true,\n";
      }

      if (fieldAttr.unique || dbField === "email" || dbField === "token") {
        columnDef += "            isUnique: true,\n";
      }

      const defaultValue = formatDefaultValueForMigration(fieldAttr);
      if (defaultValue) {
        columnDef += `            default: ${defaultValue},\n`;
      }

      columnDef += "          }";
      columns.push(columnDef);

      if (fieldAttr.index) {
        postCreateStatements.push(`    await queryRunner.createIndex(
      '${tableName}',
      new TableIndex({
        name: '${tableName}_${dbField}_idx',
        columnNames: ['${dbField}'],
      }),
    );`);
      }

      if (fieldAttr.references) {
        postCreateStatements.push(`    await queryRunner.createForeignKey(
      '${tableName}',
      new TableForeignKey({
        columnNames: ['${dbField}'],
        referencedTableName: '${fieldAttr.references.model}',
        referencedColumnNames: ['${fieldAttr.references.field}'],
        onDelete: '${(fieldAttr.references.onDelete || "cascade").toUpperCase()}',
      }),
    );`);
      }
    }

    migrationCode += `${columns.join(",\n")}\n`;
    migrationCode += "        ],\n";
    migrationCode += "      }),\n";
    migrationCode += "    );\n\n";

    if (postCreateStatements.length > 0) {
      migrationCode += `${postCreateStatements.join("\n\n")}\n`;
    }
  } else if (action === "alter" && changes) {
    if (changes.addColumns && changes.addColumns.length > 0) {
      for (const { name, field } of changes.addColumns) {
        const typeInfo = mapFieldTypeToTypeORM(field.type, field, dataSource);
        migrationCode += `    await queryRunner.addColumn('${tableName}', new TableColumn({\n`;
        migrationCode += `      name: '${field.fieldName || name}',\n`;
        migrationCode += `      type: '${typeInfo.type}',\n`;
        migrationCode += `      isNullable: ${!field.required},\n`;
        if (
          field.unique ||
          (field.fieldName || name) === "email" ||
          (field.fieldName || name) === "token"
        ) {
          migrationCode += "      isUnique: true,\n";
        }
        const defaultValue = formatDefaultValueForMigration(field);
        if (defaultValue) {
          migrationCode += `      default: ${defaultValue},\n`;
        }
        migrationCode += "    }));\n\n";
        if (field.index) {
          const dbField = field.fieldName || name;
          migrationCode += `    await queryRunner.createIndex('${tableName}', new TableIndex({ name: '${tableName}_${dbField}_idx', columnNames: ['${dbField}'] }));\n\n`;
        }
        if (field.references) {
          const dbField = field.fieldName || name;
          migrationCode += `    await queryRunner.createForeignKey('${tableName}', new TableForeignKey({ columnNames: ['${dbField}'], referencedTableName: '${field.references.model}', referencedColumnNames: ['${field.references.field}'], onDelete: '${(field.references.onDelete || "cascade").toUpperCase()}' }));\n\n`;
        }
      }
    }

    if (changes.dropColumns && changes.dropColumns.length > 0) {
      for (const columnName of changes.dropColumns) {
        migrationCode += `    await queryRunner.dropColumn('${tableName}', '${columnName}');\n\n`;
      }
    }

    if (changes.modifyColumns && changes.modifyColumns.length > 0) {
      for (const { name, field } of changes.modifyColumns) {
        const typeInfo = mapFieldTypeToTypeORM(field.type, field, dataSource);
        migrationCode += `    await queryRunner.changeColumn('${tableName}', '${name}', new TableColumn({\n`;
        migrationCode += `      name: '${field.fieldName || name}',\n`;
        migrationCode += `      type: '${typeInfo.type}',\n`;
        migrationCode += `      isNullable: ${!field.required},\n`;
        if (
          field.unique ||
          (field.fieldName || name) === "email" ||
          (field.fieldName || name) === "token"
        ) {
          migrationCode += "      isUnique: true,\n";
        }
        const defaultValue = formatDefaultValueForMigration(field);
        if (defaultValue) {
          migrationCode += `      default: ${defaultValue},\n`;
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
    if (changes.addColumns && changes.addColumns.length > 0) {
      for (const { name, field } of changes.addColumns) {
        migrationCode += `    await queryRunner.dropColumn('${tableName}', '${field.fieldName || name}');\n`;
      }
    }
    if (changes.dropColumns && changes.dropColumns.length > 0) {
      for (const columnName of changes.dropColumns) {
        migrationCode += `    await queryRunner.addColumn('${tableName}', new TableColumn({ name: '${columnName}', type: 'text', isNullable: true }));\n`;
      }
    }
  }

  migrationCode += "  }\n";
  migrationCode += "}";

  return migrationCode;
}

export interface TypeormAdapterOptions {
  outputDir?: string;
  migrationsDir?: string;
  entitiesDir?: string;
  usePlural?: boolean;
  debugLogs?: boolean;
  softDeleteEnabledEntities?: string[];
}

function createSchemaGenerationDataSource(dataSource: DataSource): DataSource {
  return new DataSource({
    ...dataSource.options,
    entities: [],
    migrations: [],
    subscribers: [],
    migrationsRun: false,
    synchronize: false,
    dropSchema: false,
  });
}

export const typeormAdapter = (dataSource: DataSource, options?: TypeormAdapterOptions) =>
  createAdapterFactory({
    config: {
      adapterId: "typeorm",
      adapterName: "TypeORM",
      usePlural: options?.usePlural ?? false,
      debugLogs: options?.debugLogs ?? false,
      supportsJSON: true,
      supportsDates: false,
      supportsBooleans: false,
      supportsNumericIds: false,
    },
    adapter: ({
      getModelName,
      getDefaultModelName,
      getFieldName,
      transformInput,
      transformOutput,
      transformWhereClause,
    }) => {
      const fieldMapCache: Record<string, Record<string, string>> = {};

      function convertWhereToFindOptions(
        model: string,
        action:
          | "create"
          | "update"
          | "updateMany"
          | "findOne"
          | "findMany"
          | "delete"
          | "deleteMany"
          | "count",
        where?: Where[],
      ): FindOptionsWhere<ObjectLiteral>[] {
        if (!where || where.length === 0) {
          return [{}];
        }

        const cleanedWhere = transformWhereClause({ model, where, action });
        const findOptions: FindOptionsWhere<ObjectLiteral>[] = [];
        let currentGroup: FindOptionsWhere<ObjectLiteral> = {};
        findOptions.push(currentGroup);

        for (const w of cleanedWhere) {
          if (w.connector === "OR") {
            currentGroup = {};
            findOptions.push(currentGroup);
          }
          const field = w.field;
          const value =
            !w.operator || w.operator === "eq"
              ? w.value
              : convertOperatorToTypeORM(w.operator, w.value);

          currentGroup[field] = value;
        }

        return findOptions;
      }
      async function deleteOrSoftDeleteHandler(
        repository: Repository<ObjectLiteral>,
        findOptions: FindOptionsWhere<ObjectLiteral>,
        repositoryName: string,
      ) {
        let result: UpdateResult | DeleteResult;
        if (options?.softDeleteEnabledEntities?.includes(repositoryName)) {
          const hasDeletedAtColumn = repository.metadata.columns.some(
            (column) => column.propertyName === "deletedAt",
          );

          if (!hasDeletedAtColumn) {
            throw new BetterAuthError(`Failed to soft delete. Couldn't locate deletedAt column.`);
          }
          result = await repository.softDelete(findOptions);
        } else {
          result = await repository.delete(findOptions);
        }
        return result;
      }
      function buildWhereSql(
        model: string,
        action:
          | "update"
          | "updateMany"
          | "findOne"
          | "findMany"
          | "delete"
          | "deleteMany"
          | "count",
        where?: Where[],
      ) {
        const cleaned = where?.length ? transformWhereClause({ model, where, action }) : [];

        if (!cleaned.length) {
          return { sql: "", params: [] as unknown[] };
        }

        const params: unknown[] = [];
        const parts: string[] = [];

        for (let i = 0; i < cleaned.length; i++) {
          const w = cleaned[i];
          const prefix = i === 0 ? "" : ` ${w.connector ?? "AND"} `;
          let mappedFieldName = getFieldName({ model, field: w.field });

          if (fieldMapCache[model]?.[w.field]) {
            mappedFieldName = fieldMapCache[model][w.field];
          }
          const col = escapeId(dataSource, mappedFieldName);

          const push = (value: unknown) => {
            params.push(value);
            return "?";
          };

          switch (w.operator ?? "eq") {
            case "eq":
              parts.push(`${prefix}${col} = ${push(w.value)}`);
              break;
            case "ne":
              parts.push(`${prefix}${col} <> ${push(w.value)}`);
              break;
            case "lt":
              parts.push(`${prefix}${col} < ${push(w.value)}`);
              break;
            case "lte":
              parts.push(`${prefix}${col} <= ${push(w.value)}`);
              break;
            case "gt":
              parts.push(`${prefix}${col} > ${push(w.value)}`);
              break;
            case "gte":
              parts.push(`${prefix}${col} >= ${push(w.value)}`);
              break;
            case "contains":
              parts.push(`${prefix}${col} LIKE ${push(`%${String(w.value)}%`)}`);
              break;
            case "starts_with":
              parts.push(`${prefix}${col} LIKE ${push(`${String(w.value)}%`)}`);
              break;
            case "ends_with":
              parts.push(`${prefix}${col} LIKE ${push(`%${String(w.value)}`)}`);
              break;
            case "in": {
              const values = Array.isArray(w.value) ? w.value : [];
              if (!values.length) {
                parts.push(`${prefix}1 = 0`);
              } else {
                const placeholders = values.map((v) => push(v)).join(", ");
                parts.push(`${prefix}${col} IN (${placeholders})`);
              }
              break;
            }
            case "not_in": {
              const values = Array.isArray(w.value) ? w.value : [];
              if (!values.length) {
                parts.push(`${prefix}1 = 1`);
              } else {
                const placeholders = values.map((v) => push(v)).join(", ");
                parts.push(`${prefix}${col} NOT IN (${placeholders})`);
              }
              break;
            }
            default:
              parts.push(`${prefix}${col} = ${push(w.value)}`);
              break;
          }
        }

        return {
          sql: ` WHERE ${parts.join("")}`,
          params,
        };
      }

      async function rawCreate(model: string, data: Record<string, unknown>, select?: string[]) {
        const defaultModelName = getDefaultModelName(model);
        const tableName = getModelName(model);
        const transformedData = await transformInput(data, defaultModelName, "create");

        const queryRunner = dataSource.createQueryRunner();
        await queryRunner.connect();

        let existingColumns: Set<string> | null = null;
        try {
          const table = await queryRunner.getTable(tableName);
          if (table) {
            existingColumns = new Set(table.columns.map((col) => col.name));
          }
        } catch {}

        const createFieldMap: Record<string, string> = {};
        for (const [key] of Object.entries(data)) {
          if (existingColumns?.has(key)) {
            createFieldMap[key] = key;
          } else {
            let found = false;
            const variants = [
              key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
              key.replace(/([A-Z])/g, "_$1").toLowerCase(),
            ];
            for (const variant of variants) {
              if (existingColumns?.has(variant)) {
                createFieldMap[key] = variant;
                found = true;
                break;
              }
            }
            if (!found && existingColumns) {
              for (const col of Array.from(existingColumns)) {
                if (
                  key.toLowerCase().includes(col.toLowerCase()) ||
                  col.toLowerCase().includes(key.toLowerCase())
                ) {
                  const keyLower = key.toLowerCase().replace(/_/g, "");
                  const colLower = col.toLowerCase().replace(/_/g, "");
                  if (col.length < key.length && keyLower.startsWith(colLower)) {
                    createFieldMap[key] = col;
                    found = true;
                    break;
                  }
                }
              }
            }
            if (!found) {
              const dbFieldName = getFieldName({ model, field: key });
              if (existingColumns?.has(dbFieldName)) {
                createFieldMap[key] = dbFieldName;
              } else if (!existingColumns) {
                createFieldMap[key] = dbFieldName || key;
              }
            }
          }
        }

        const mappedData: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(transformedData)) {
          if (value === undefined) {
            continue;
          }
          const targetKey = createFieldMap[key] || key;
          mappedData[targetKey] = value;
        }

        if (!fieldMapCache[model]) {
          fieldMapCache[model] = createFieldMap;
        }

        await ensureTableExists(dataSource, tableName, mappedData);

        let updatedExistingColumns: Set<string> | null = null;
        try {
          const table = await queryRunner.getTable(tableName);
          if (table) {
            updatedExistingColumns = new Set(table.columns.map((col) => col.name));
          }
        } catch {}

        const insertData: Record<string, unknown> = {};
        if (updatedExistingColumns) {
          for (const [key, value] of Object.entries(mappedData)) {
            if (value === undefined) {
              continue;
            }
            if (updatedExistingColumns.has(key)) {
              insertData[key] = value;
            }
          }
        } else {
          Object.assign(insertData, mappedData);
        }
        const entries = Object.entries(insertData).filter(([, value]) => value !== undefined);
        const columns = entries.map(([key]) => escapeId(dataSource, key)).join(", ");
        const placeholders = entries.map(() => "?").join(", ");
        const values = entries.map(([, value]) => {
          if (value instanceof Date) {
            return value.toISOString();
          }
          if (typeof value === "object" && value !== null) {
            return JSON.stringify(value);
          }
          return value;
        });

        try {
          const isSqlite =
            dataSource.options.type === "sqlite" || dataSource.options.type === "better-sqlite3";
          if (isSqlite) {
            await queryRunner.query("PRAGMA foreign_keys = OFF");
          }
          try {
            const sql = `INSERT INTO ${escapeId(dataSource, tableName)} (${columns}) VALUES (${placeholders})`;
            await queryRunner.query(sql, values);
          } finally {
            if (isSqlite) {
              await queryRunner.query("PRAGMA foreign_keys = ON");
            }
          }

          const rows = await queryRunner.query(
            `SELECT * FROM ${escapeId(dataSource, tableName)} WHERE ${escapeId(dataSource, "id")} = ?`,
            [mappedData.id],
          );

          if (rows[0]) {
            const reverseFieldMap: Record<string, string> = {};
            for (const [originalKey, mappedKey] of Object.entries(createFieldMap)) {
              reverseFieldMap[mappedKey] = originalKey;
            }
            const denormalizedRow: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(rows[0])) {
              const originalKey = reverseFieldMap[key] || key;
              if (typeof value === "string") {
                try {
                  if (
                    (value.startsWith("{") && value.endsWith("}")) ||
                    (value.startsWith("[") && value.endsWith("]"))
                  ) {
                    denormalizedRow[originalKey] = JSON.parse(value);
                    continue;
                  }
                } catch {}
              }
              denormalizedRow[originalKey] = value;
            }
            return await transformOutput(denormalizedRow, defaultModelName, select);
          }
          return await transformOutput(mappedData, defaultModelName, select);
        } finally {
          await queryRunner.release();
        }
      }

      async function rawFindOne<T>(
        model: string,
        where: CleanedWhere[],
        select?: string[],
      ): Promise<T | null> {
        const defaultModelName = getDefaultModelName(model);
        const tableName = getModelName(model);
        const { sql, params } = buildWhereSql(model, "findOne", where);

        const queryRunner = dataSource.createQueryRunner();
        await queryRunner.connect();
        try {
          const rows = await queryRunner.query(
            `SELECT * FROM ${escapeId(dataSource, tableName)}${sql} LIMIT 1`,
            params,
          );
          if (!rows[0]) {
            return null;
          }
          const reverseFieldMap: Record<string, string> = {};
          if (fieldMapCache[model]) {
            for (const [originalKey, mappedKey] of Object.entries(fieldMapCache[model])) {
              reverseFieldMap[mappedKey] = originalKey;
            }
          }
          const denormalizedRow: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(rows[0])) {
            const originalKey = reverseFieldMap[key] || key;
            if (typeof value === "string") {
              try {
                if (
                  (value.startsWith("{") && value.endsWith("}")) ||
                  (value.startsWith("[") && value.endsWith("]"))
                ) {
                  denormalizedRow[originalKey] = JSON.parse(value);
                  continue;
                }
              } catch {}
            }
            denormalizedRow[originalKey] = value;
          }
          return (await transformOutput(denormalizedRow, defaultModelName, select)) as T;
        } finally {
          await queryRunner.release();
        }
      }

      async function rawFindMany<T>(
        model: string,
        where?: CleanedWhere[],
        limit?: number,
        sortBy?: { field: string; direction: "asc" | "desc" },
        offset?: number,
      ): Promise<T[]> {
        const defaultModelName = getDefaultModelName(model);
        const tableName = getModelName(model);
        const { sql, params } = buildWhereSql(model, "findMany", where);

        let query = `SELECT * FROM ${escapeId(dataSource, tableName)}${sql}`;

        if (sortBy?.field) {
          let mappedSortField = getFieldName({ model, field: sortBy.field });
          if (fieldMapCache[model]?.[sortBy.field]) {
            mappedSortField = fieldMapCache[model][sortBy.field];
          }
          query += ` ORDER BY ${escapeId(dataSource, mappedSortField)} ${sortBy.direction === "desc" ? "DESC" : "ASC"}`;
        }
        query += ` LIMIT ${limit || 100}`;
        if (offset) {
          query += ` OFFSET ${offset}`;
        }

        const queryRunner = dataSource.createQueryRunner();
        await queryRunner.connect();
        try {
          const rows = await queryRunner.query(query, params);
          const reverseFieldMap: Record<string, string> = {};
          if (fieldMapCache[model]) {
            for (const [originalKey, mappedKey] of Object.entries(fieldMapCache[model])) {
              reverseFieldMap[mappedKey] = originalKey;
            }
          }
          const transformed = await Promise.all(
            rows.map((r: Record<string, unknown>) => {
              const denormalizedRow: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(r)) {
                const originalKey = reverseFieldMap[key] || key;
                if (typeof value === "string") {
                  try {
                    if (
                      (value.startsWith("{") && value.endsWith("}")) ||
                      (value.startsWith("[") && value.endsWith("]"))
                    ) {
                      denormalizedRow[originalKey] = JSON.parse(value);
                      continue;
                    }
                  } catch {}
                }
                denormalizedRow[originalKey] = value;
              }
              return transformOutput(denormalizedRow, defaultModelName);
            }),
          );
          return transformed as T[];
        } finally {
          await queryRunner.release();
        }
      }

      async function rawUpdate(model: string, where: Where[], update: Record<string, unknown>) {
        const defaultModelName = getDefaultModelName(model);
        const tableName = getModelName(model);
        const transformed = await transformInput(update, defaultModelName, "update");

        const { sql: whereSql, params: whereParams } = buildWhereSql(model, "findOne", where);

        const queryRunner = dataSource.createQueryRunner();
        await queryRunner.connect();
        try {
          const existing = await queryRunner.query(
            `SELECT * FROM ${escapeId(dataSource, tableName)}${whereSql} LIMIT 1`,
            whereParams,
          );

          if (!existing[0]) {
            return null;
          }

          const setClauses: string[] = [];
          const setValues: unknown[] = [];
          for (const [key, value] of Object.entries(transformed)) {
            if (value !== undefined) {
              setClauses.push(`${escapeId(dataSource, key)} = ?`);
              if (value instanceof Date) {
                setValues.push(value.toISOString());
              } else if (typeof value === "object" && value !== null) {
                setValues.push(JSON.stringify(value));
              } else {
                setValues.push(value);
              }
            }
          }

          if (setClauses.length > 0) {
            await queryRunner.query(
              `UPDATE ${escapeId(dataSource, tableName)} SET ${setClauses.join(", ")} WHERE ${escapeId(dataSource, "id")} = ?`,
              [...setValues, existing[0].id],
            );
          }

          const result = await queryRunner.query(
            `SELECT * FROM ${escapeId(dataSource, tableName)} WHERE ${escapeId(dataSource, "id")} = ?`,
            [existing[0].id],
          );

          if (result[0]) {
            const denormalizedRow: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(result[0])) {
              if (typeof value === "string") {
                try {
                  if (
                    (value.startsWith("{") && value.endsWith("}")) ||
                    (value.startsWith("[") && value.endsWith("]"))
                  ) {
                    denormalizedRow[key] = JSON.parse(value);
                    continue;
                  }
                } catch {}
              }
              denormalizedRow[key] = value;
            }
            return await transformOutput(denormalizedRow, defaultModelName);
          }
          return null;
        } finally {
          await queryRunner.release();
        }
      }

      async function rawDelete(model: string, where: Where[]) {
        const tableName = getModelName(model);
        const { sql, params } = buildWhereSql(model, "delete", where);

        const queryRunner = dataSource.createQueryRunner();
        await queryRunner.connect();
        try {
          await queryRunner.query(`DELETE FROM ${escapeId(dataSource, tableName)}${sql}`, params);
        } finally {
          await queryRunner.release();
        }
      }

      async function rawCount(model: string, where?: Where[]) {
        const tableName = getModelName(model);
        const { sql, params } = buildWhereSql(model, "count", where);

        const queryRunner = dataSource.createQueryRunner();
        await queryRunner.connect();
        try {
          const result = await queryRunner.query(
            `SELECT COUNT(*) as cnt FROM ${escapeId(dataSource, tableName)}${sql}`,
            params,
          );
          return Number(result[0]?.cnt ?? 0);
        } finally {
          await queryRunner.release();
        }
      }

      async function rawUpdateMany(
        model: string,
        where: Where[] | undefined,
        update: Record<string, unknown>,
      ) {
        const defaultModelName = getDefaultModelName(model);
        const tableName = getModelName(model);
        const transformed = await transformInput(update, defaultModelName, "update");

        const { sql: whereSql, params: whereParams } = buildWhereSql(model, "updateMany", where);

        const setClauses: string[] = [];
        const setValues: unknown[] = [];
        for (const [key, value] of Object.entries(transformed)) {
          if (value !== undefined) {
            setClauses.push(`${escapeId(dataSource, key)} = ?`);
            if (value instanceof Date) {
              setValues.push(value.toISOString());
            } else if (typeof value === "object" && value !== null) {
              setValues.push(JSON.stringify(value));
            } else {
              setValues.push(value);
            }
          }
        }

        if (setClauses.length === 0) {
          return 0;
        }

        const queryRunner = dataSource.createQueryRunner();
        await queryRunner.connect();
        try {
          const result = await queryRunner.query(
            `UPDATE ${escapeId(dataSource, tableName)} SET ${setClauses.join(", ")}${whereSql}`,
            [...setValues, ...whereParams],
          );
          return typeof result?.changes === "number" ? result.changes : 0;
        } finally {
          await queryRunner.release();
        }
      }

      async function rawDeleteMany(model: string, where?: Where[]) {
        const tableName = getModelName(model);
        const { sql, params } = buildWhereSql(model, "deleteMany", where);

        const queryRunner = dataSource.createQueryRunner();
        await queryRunner.connect();
        try {
          const result = await queryRunner.query(
            `DELETE FROM ${escapeId(dataSource, tableName)}${sql}`,
            params,
          );
          return typeof result?.changes === "number" ? result.changes : 0;
        } finally {
          await queryRunner.release();
        }
      }

      return {
        async create({ data, model, select }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          try {
            return (await rawCreate(model, data as Record<string, unknown>, select)) as typeof data;
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to create ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async update({ model, where, update }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          try {
            return (await rawUpdate(
              model,
              where,
              update as Record<string, unknown>,
            )) as typeof update;
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to update ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async delete({ model, where }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }

          const repositoryName = getModelName(model);
          const repository = tryGetRepository(dataSource, repositoryName);

          if (repository && options?.softDeleteEnabledEntities?.includes(repositoryName)) {
            try {
              const findOptionsArr = convertWhereToFindOptions(model, "delete", where);
              const findOptions = findOptionsArr.length === 1 ? findOptionsArr[0] : findOptionsArr;
              await deleteOrSoftDeleteHandler(repository, findOptions, repositoryName);
              return;
            } catch (error: unknown) {
              throw new BetterAuthError(
                `Failed to delete ${model}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }

          try {
            await rawDelete(model, where);
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to delete ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async findOne<T>({
          model,
          where,
          select,
        }: {
          model: string;
          where: CleanedWhere[];
          select?: string[] | undefined;
        }): Promise<T | null> {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          try {
            return await rawFindOne<T>(model, where, select);
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to find ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async findMany<T>({
          model,
          where,
          limit,
          sortBy,
          offset,
        }: {
          model: string;
          where?: CleanedWhere[] | undefined;
          limit: number;
          sortBy?:
            | {
                field: string;
                direction: "asc" | "desc";
              }
            | undefined;
          offset?: number | undefined;
        }): Promise<T[]> {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          try {
            return await rawFindMany<T>(model, where, limit, sortBy, offset);
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to find many ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async count({ model, where }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          try {
            return await rawCount(model, where);
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to count ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async updateMany({ model, where, update }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          try {
            return await rawUpdateMany(model, where, update as Record<string, unknown>);
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to update many ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async deleteMany({ model, where }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }

          const repositoryName = getModelName(model);
          const repository = tryGetRepository(dataSource, repositoryName);

          if (repository && options?.softDeleteEnabledEntities?.includes(repositoryName)) {
            try {
              if (!where || where.length === 0) {
                const result = await repository
                  .createQueryBuilder()
                  .softDelete()
                  .from(repository.target)
                  .where("1=1")
                  .execute();
                return result.affected || 0;
              }
              const findOptionsArr = convertWhereToFindOptions(model, "deleteMany", where);
              const findOptions = findOptionsArr.length === 1 ? findOptionsArr[0] : findOptionsArr;
              const result = await deleteOrSoftDeleteHandler(
                repository,
                findOptions,
                repositoryName,
              );
              return result.affected || 0;
            } catch (error: unknown) {
              throw new BetterAuthError(
                `Failed to delete many ${model}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }

          try {
            return await rawDeleteMany(model, where);
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to delete many ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async createSchema({ tables, file }) {
          let schemaDataSource = dataSource;
          let destroySchemaDataSource = false;

          if (!schemaDataSource.isInitialized) {
            schemaDataSource = createSchemaGenerationDataSource(dataSource);
            destroySchemaDataSource = true;
            await schemaDataSource.initialize();
          }
          try {
            const timestamp = Date.now();
            const typeormDir = path.resolve(options?.outputDir ?? "./typeorm");
            const migrationsDir = path.resolve(
              options?.migrationsDir ?? `${options?.outputDir ?? "./typeorm"}/migrations`,
            );
            const entitiesDir = path.resolve(
              options?.entitiesDir ?? `${options?.outputDir ?? "./typeorm"}/entities`,
            );

            if (!fs.existsSync(typeormDir)) {
              fs.mkdirSync(typeormDir, { recursive: true });
            }
            if (!fs.existsSync(migrationsDir)) {
              fs.mkdirSync(migrationsDir, { recursive: true });
            }
            if (!fs.existsSync(entitiesDir)) {
              fs.mkdirSync(entitiesDir, { recursive: true });
            }

            const queryRunner = schemaDataSource.createQueryRunner();
            await queryRunner.connect();

            let changelogContent = `# TypeORM Schema Changes - ${new Date().toISOString()}\n\n`;
            let hasChanges = false;

            const expectedTables = Object.keys(tables);

            for (const modelName of expectedTables) {
              const modelSchema = tables[modelName];
              const tableName = modelSchema.modelName;

              const tableExists = await queryRunner.hasTable(tableName);

              const entityCode = generateEntity(dataSource, modelName, modelSchema);
              const entityPath = path.join(
                entitiesDir,
                `${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts`,
              );

              if (!tableExists) {
                const migrationFileName = `${timestamp}-create-${modelName}.ts`;
                const migrationCode = generateMigration(
                  dataSource,
                  modelName,
                  modelSchema,
                  timestamp,
                  "create",
                );
                const migrationPath = path.join(migrationsDir, migrationFileName);
                fs.writeFileSync(migrationPath, migrationCode);
                fs.writeFileSync(entityPath, entityCode);

                changelogContent += `- CREATE Migration: migrations/${migrationFileName}\n`;
                changelogContent += `- Entity: entities/${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts\n\n`;
                hasChanges = true;
              } else {
                const table = await queryRunner.getTable(tableName);
                if (!table) {
                  continue;
                }

                const existingColumns = table.columns.map((col) => col.name);
                const expectedFields = modelSchema.fields;

                const addColumns = [];
                const dropColumns = [];

                for (const [fieldName, field] of Object.entries(expectedFields)) {
                  const dbField = field.fieldName || fieldName;
                  if (!existingColumns.includes(dbField)) {
                    addColumns.push({ name: fieldName, field });
                  }
                }

                for (const existingCol of existingColumns) {
                  if (existingCol === "id") {
                    continue;
                  }
                  const fieldExists = Object.entries(expectedFields).some(
                    ([fieldName, field]) => (field.fieldName || fieldName) === existingCol,
                  );
                  if (!fieldExists) {
                    dropColumns.push(existingCol);
                  }
                }

                if (addColumns.length > 0 || dropColumns.length > 0) {
                  const migrationFileName = `${timestamp}-alter-${modelName}.ts`;
                  const changes = { addColumns, dropColumns, modifyColumns: [] };
                  const migrationCode = generateMigration(
                    dataSource,
                    modelName,
                    modelSchema,
                    timestamp,
                    "alter",
                    changes,
                  );
                  const migrationPath = path.join(migrationsDir, migrationFileName);
                  fs.writeFileSync(migrationPath, migrationCode);
                  fs.writeFileSync(entityPath, entityCode);

                  changelogContent += `- ALTER Migration: migrations/${migrationFileName}\n`;
                  changelogContent += `- Updated Entity: entities/${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts\n`;

                  if (addColumns.length > 0) {
                    changelogContent += `  - Added columns: ${addColumns.map((col) => col.field.fieldName || col.name).join(", ")}\n`;
                  }
                  if (dropColumns.length > 0) {
                    changelogContent += `  - Removed columns: ${dropColumns.join(", ")}\n`;
                  }
                  changelogContent += "\n";
                  hasChanges = true;
                } else {
                  if (fs.existsSync(entityPath)) {
                    const existingContent = fs.readFileSync(entityPath, "utf-8");
                    if (existingContent !== entityCode) {
                      fs.writeFileSync(entityPath, entityCode);
                      changelogContent += `- Updated entity: entities/${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts\n\n`;
                      hasChanges = true;
                    }
                  } else {
                    fs.writeFileSync(entityPath, entityCode);
                    changelogContent += `- Generated missing entity: entities/${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts\n\n`;
                    hasChanges = true;
                  }
                }
              }
            }

            await queryRunner.release();
            if (destroySchemaDataSource) {
              await schemaDataSource.destroy();
            }

            if (!hasChanges) {
              changelogContent += "Schema is up to date. No changes detected.\n";
            }

            return {
              code: changelogContent,
              path: file ?? "typeorm/changelog.txt",
            };
          } catch (error) {
            if (destroySchemaDataSource && schemaDataSource.isInitialized) {
              await schemaDataSource.destroy();
            }
            throw new BetterAuthError(
              `Failed to create schema: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      };
    },
  });
