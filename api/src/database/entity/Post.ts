/* eslint-disable camelcase */
import { Field, ID, ObjectType } from "type-graphql";
import { Entity, PrimaryGeneratedColumn, Column, JoinColumn, ManyToOne, BaseEntity } from "typeorm";
import { Author } from "./Author";
import { Status } from "./Status";

@Entity()
@ObjectType()
export class Post extends BaseEntity {
	@PrimaryGeneratedColumn()
	@Field(() => ID)
	id: number;

	@Column({ length: 255 })
	@Field(() => String)
	title: string;

	@Column({ length: 2000 })
	@Field(() => String)
	description: string;

	@ManyToOne(() => Status, (status) => status.Posts)
	@JoinColumn()
	@Field(() => Status)
	status: number;

	@ManyToOne(() => Author, (author) => author.Posts)
	@JoinColumn()
	@Field(() => Author)
	author: number;

	@Column({ default: new Date() })
	@Field(() => Date)
	created: Date;
}
