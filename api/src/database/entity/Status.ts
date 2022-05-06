/* eslint-disable camelcase */
import { Field, ID, ObjectType } from "type-graphql";
import { Entity, PrimaryGeneratedColumn, Column, OneToMany, BaseEntity } from "typeorm";
import { Author } from "./Author";
import { Post } from "./Post";

@Entity()
@ObjectType()
export class Status extends BaseEntity {
	@PrimaryGeneratedColumn()
	@Field(() => ID)
	id: number;

	@Column({ length: 100 })
	@Field(() => String)
	title: string;

	@OneToMany(() => Author, (author) => author.status)
	@Field(() => Author)
	Authors: Author[];

	@OneToMany(() => Post, (post) => post.status)
	@Field(() => Post)
	Posts: Post[];
}
