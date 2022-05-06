import { MigrationInterface, QueryRunner } from "typeorm";

export class postAuthorid1651837803080 implements MigrationInterface {
    name = 'postAuthorid1651837803080'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "post" DROP CONSTRAINT "FK_9074a17aa24c039c7c98d213be5"`);
        await queryRunner.query(`ALTER TABLE "author" DROP CONSTRAINT "FK_cf08f13d2cf4bd05655b5ba2c26"`);
        await queryRunner.query(`ALTER TABLE "author" RENAME COLUMN "statusIdId" TO "statusId"`);
        await queryRunner.query(`ALTER TABLE "post" DROP COLUMN "statusIdId"`);
        await queryRunner.query(`ALTER TABLE "post" ADD "statusId" integer`);
        await queryRunner.query(`ALTER TABLE "post" ADD "authorId" integer`);
        await queryRunner.query(`ALTER TABLE "post" ALTER COLUMN "created" SET DEFAULT '"2022-05-06T11:50:06.764Z"'`);
        await queryRunner.query(`ALTER TABLE "author" ALTER COLUMN "created" SET DEFAULT '"2022-05-06T11:50:06.764Z"'`);
        await queryRunner.query(`ALTER TABLE "post" ADD CONSTRAINT "FK_465a7c1cd00c83b42a1fc21cf1b" FOREIGN KEY ("statusId") REFERENCES "status"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "post" ADD CONSTRAINT "FK_c6fb082a3114f35d0cc27c518e0" FOREIGN KEY ("authorId") REFERENCES "author"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "author" ADD CONSTRAINT "FK_01b7bc31d3da30c6b213c145cac" FOREIGN KEY ("statusId") REFERENCES "status"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "author" DROP CONSTRAINT "FK_01b7bc31d3da30c6b213c145cac"`);
        await queryRunner.query(`ALTER TABLE "post" DROP CONSTRAINT "FK_c6fb082a3114f35d0cc27c518e0"`);
        await queryRunner.query(`ALTER TABLE "post" DROP CONSTRAINT "FK_465a7c1cd00c83b42a1fc21cf1b"`);
        await queryRunner.query(`ALTER TABLE "author" ALTER COLUMN "created" SET DEFAULT '2022-05-05 17:24:48.27'`);
        await queryRunner.query(`ALTER TABLE "post" ALTER COLUMN "created" SET DEFAULT '2022-05-05 17:24:48.27'`);
        await queryRunner.query(`ALTER TABLE "post" DROP COLUMN "authorId"`);
        await queryRunner.query(`ALTER TABLE "post" DROP COLUMN "statusId"`);
        await queryRunner.query(`ALTER TABLE "post" ADD "statusIdId" integer`);
        await queryRunner.query(`ALTER TABLE "author" RENAME COLUMN "statusId" TO "statusIdId"`);
        await queryRunner.query(`ALTER TABLE "author" ADD CONSTRAINT "FK_cf08f13d2cf4bd05655b5ba2c26" FOREIGN KEY ("statusIdId") REFERENCES "status"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "post" ADD CONSTRAINT "FK_9074a17aa24c039c7c98d213be5" FOREIGN KEY ("statusIdId") REFERENCES "status"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

}
