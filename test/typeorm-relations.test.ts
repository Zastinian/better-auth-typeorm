import "reflect-metadata";
import {
  Column,
  DataSource,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
} from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

@Entity("images")
class ImageEntity {
  @PrimaryColumn("text")
  id!: string;

  @Column("text", { unique: true })
  storageKey!: string;
}

@Entity("roles")
class RoleEntity {
  @PrimaryColumn("text")
  id!: string;

  @Column("text", { unique: true })
  name!: string;
}

@Entity("users")
class UserEntity {
  @PrimaryColumn("text")
  id!: string;

  @Column("text")
  name!: string;

  @Column("text", { nullable: true })
  image!: string | null;

  @ManyToOne(() => ImageEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "image", referencedColumnName: "id" })
  imageRelation?: ImageEntity | null;

  @Index("users_role_id_idx")
  @Column("text", { nullable: true })
  roleId!: string | null;

  @ManyToOne(() => RoleEntity, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "roleId", referencedColumnName: "id" })
  roleRelation?: RoleEntity | null;

  @OneToMany(
    () => AddressEntity,
    (address) => address.user,
  )
  addresses?: AddressEntity[];
}

@Entity("addresses")
class AddressEntity {
  @PrimaryColumn("text")
  id!: string;

  @Column("text")
  city!: string;

  @Column("text")
  userId!: string;

  @ManyToOne(
    () => UserEntity,
    (user) => user.addresses,
    { onDelete: "CASCADE" },
  )
  @JoinColumn({ name: "userId", referencedColumnName: "id" })
  user!: UserEntity;
}

const dataSource = new DataSource({
  type: "better-sqlite3",
  database: ":memory:",
  entities: [UserEntity, ImageEntity, RoleEntity, AddressEntity],
  synchronize: true,
  logging: false,
});

describe("TypeORM entity metadata and relations", () => {
  beforeAll(async () => {
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  });

  test("initializes all entities registered by their application modules", () => {
    expect(
      dataSource.getMetadata(UserEntity).relations.map((relation) => relation.propertyName),
    ).toEqual(expect.arrayContaining(["imageRelation", "roleRelation", "addresses"]));
    expect(dataSource.getMetadata(ImageEntity).tableName).toBe("images");
    expect(dataSource.getMetadata(RoleEntity).tableName).toBe("roles");
  });

  test("persists and loads many-to-one and one-to-many relations", async () => {
    const image = await dataSource.getRepository(ImageEntity).save({
      id: "image-1",
      storageKey: "profile/image-1",
    });
    const role = await dataSource.getRepository(RoleEntity).save({
      id: "role-1",
      name: "admin",
    });
    const user = await dataSource.getRepository(UserEntity).save({
      id: "user-1",
      name: "Test User",
      image: image.id,
      roleId: role.id,
    });

    await dataSource.getRepository(AddressEntity).save({
      id: "address-1",
      city: "Lima",
      userId: user.id,
    });

    const loaded = await dataSource.getRepository(UserEntity).findOne({
      where: { id: user.id },
      relations: {
        imageRelation: true,
        roleRelation: true,
        addresses: true,
      },
    });

    expect(loaded?.imageRelation?.storageKey).toBe("profile/image-1");
    expect(loaded?.roleRelation?.name).toBe("admin");
    expect(loaded?.addresses?.map((address) => address.city)).toEqual(["Lima"]);
  });

  test("supports nullable relation-backed fields", async () => {
    const user = await dataSource.getRepository(UserEntity).save({
      id: "user-2",
      name: "Without Image",
      image: null,
      roleId: null,
    });

    const loaded = await dataSource.getRepository(UserEntity).findOne({
      where: { id: user.id },
      relations: { imageRelation: true, roleRelation: true },
    });

    expect(loaded?.image).toBeNull();
    expect(loaded?.imageRelation).toBeNull();
    expect(loaded?.roleRelation).toBeNull();
  });
});
