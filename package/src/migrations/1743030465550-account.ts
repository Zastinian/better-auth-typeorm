import { type MigrationInterface, type QueryRunner, Table, TableForeignKey } from "typeorm";

export class Account1743030465550 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "account",
        columns: [
          {
            name: "id",
            type: "varchar",
            length: "36",
            isPrimary: true,
          },
          { name: "accountId", type: "text", isNullable: false },
          { name: "providerId", type: "text", isNullable: false },
          { name: "userId", type: "varchar", length: "36", isNullable: false },
          { name: "accessToken", type: "text", isNullable: true },
          { name: "refreshToken", type: "text", isNullable: true },
          { name: "idToken", type: "text", isNullable: true },
          { name: "accessTokenExpiresAt", type: "datetime", isNullable: true },
          { name: "refreshTokenExpiresAt", type: "datetime", isNullable: true },
          { name: "scope", type: "text", isNullable: true },
          { name: "password", type: "text", isNullable: true },
          { name: "createdAt", type: "datetime", isNullable: false },
          { name: "updatedAt", type: "datetime", isNullable: false },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      "account",
      new TableForeignKey({
        name: "FK_account_userId_user_id",
        columnNames: ["userId"],
        referencedColumnNames: ["id"],
        referencedTableName: "user",
        onDelete: "CASCADE",
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("account");
  }
}
