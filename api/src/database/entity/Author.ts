/* eslint-disable camelcase */
import { Field, ID, ObjectType } from "type-graphql";
import {
	Entity,
	PrimaryGeneratedColumn,
	Column,
	JoinColumn,
	ManyToOne,
	OneToMany,
	BaseEntity,
} from "typeorm";
import { Post } from "./Post";
import { Status } from "./Status";

@Entity()
@ObjectType()
export class Author extends BaseEntity {
	@PrimaryGeneratedColumn()
	@Field(() => ID)
	id: number;

	@Column({ length: 100 })
	@Field(() => String)
	name: string;

	@Column({ length: 100 })
	@Field(() => String)
	surname: string;

	@ManyToOne(() => Status, (status) => status.Authors)
	@JoinColumn()
	@Field(() => Status)
	status: number;

	@Column({ default: new Date() })
	@Field(() => Date)
	created: Date;

	@OneToMany(() => Post, (post) => post.author)
	@Field(() => Post)
	Posts: Post[];
}
