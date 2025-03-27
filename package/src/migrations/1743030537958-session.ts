import {
  type MigrationInterface,
  type QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from "typeorm";

export class Session1743030537958 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "session",
        columns: [
          {
            name: "id",
            type: "varchar",
            length: "36",
            isPrimary: true,
          },
          { name: "expiresAt", type: "datetime", isNullable: false },
          { name: "token", type: "varchar", length: "255" },
          { name: "createdAt", type: "datetime", isNullable: false },
          { name: "updatedAt", type: "datetime", isNullable: false },
          { name: "ipAddress", type: "text", isNullable: true },
          { name: "userAgent", type: "text", isNullable: true },
          { name: "userId", type: "varchar", length: "36", isNullable: false },
        ],
      }),
    );
    await queryRunner.createIndex(
      "session",
      new TableIndex({
        name: "IDX_session_token",
        columnNames: ["token"],
        isUnique: true,
      }),
    );
    await queryRunner.createForeignKey(
      "session",
      new TableForeignKey({
        name: "FK_session_userId_user_id",
        columnNames: ["userId"],
        referencedColumnNames: ["id"],
        referencedTableName: "user",
        onDelete: "CASCADE",
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("session");
  }
}
