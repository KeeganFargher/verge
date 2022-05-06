/* eslint-disable class-methods-use-this */
import { MigrationInterface, QueryRunner } from "typeorm";

export class init1651771485761 implements MigrationInterface {
	name = "init1651771485761";

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "post" ("id" SERIAL NOT NULL, "title" character varying(255) NOT NULL, "description" character varying(2000) NOT NULL, "created" TIMESTAMP NOT NULL DEFAULT '"2022-05-05T17:24:48.270Z"', "statusIdId" integer, CONSTRAINT "PK_be5fda3aac270b134ff9c21cdee" PRIMARY KEY ("id"))`,
		);
		await queryRunner.query(
			`CREATE TABLE "status" ("id" SERIAL NOT NULL, "title" character varying(100) NOT NULL, CONSTRAINT "PK_e12743a7086ec826733f54e1d95" PRIMARY KEY ("id"))`,
		);
		await queryRunner.query(
			`CREATE TABLE "author" ("id" SERIAL NOT NULL, "name" character varying(100) NOT NULL, "surname" character varying(100) NOT NULL, "created" TIMESTAMP NOT NULL DEFAULT '"2022-05-05T17:24:48.270Z"', "statusIdId" integer, CONSTRAINT "PK_5a0e79799d372fe56f2f3fa6871" PRIMARY KEY ("id"))`,
		);
		await queryRunner.query(
			`ALTER TABLE "post" ADD CONSTRAINT "FK_9074a17aa24c039c7c98d213be5" FOREIGN KEY ("statusIdId") REFERENCES "status"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
		);
		await queryRunner.query(
			`ALTER TABLE "author" ADD CONSTRAINT "FK_cf08f13d2cf4bd05655b5ba2c26" FOREIGN KEY ("statusIdId") REFERENCES "status"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`ALTER TABLE "author" DROP CONSTRAINT "FK_cf08f13d2cf4bd05655b5ba2c26"`,
		);
		await queryRunner.query(`ALTER TABLE "post" DROP CONSTRAINT "FK_9074a17aa24c039c7c98d213be5"`);
		await queryRunner.query(`DROP TABLE "author"`);
		await queryRunner.query(`DROP TABLE "status"`);
		await queryRunner.query(`DROP TABLE "post"`);
	}
}
