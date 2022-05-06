/* eslint-disable class-methods-use-this */
import { Resolver, Query } from "type-graphql";
import { Service } from "typedi";
import { Post } from "../../../../database/entity";

@Resolver()
@Service()
export default class GetPostsResolver {
	@Query(() => [Post], { description: "List of posts" })
	async posts(): Promise<Post[]> {
		return Post.find();
	}
}
