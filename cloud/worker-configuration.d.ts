/* Generated binding surface synchronized with wrangler.staging.jsonc. */
interface __BaseEnv_Env {
	DB: D1Database;
	JOB_QUEUE: Queue;
	JOB_COORDINATOR: DurableObjectNamespace<import("./src/index").JobCoordinator>;
	ANALYSIS_CONTAINER: DurableObjectNamespace<import("./src/index").AnalysisContainer>;
	ANALYSIS_CONTAINER_PRECISION: DurableObjectNamespace<import("./src/index").AnalysisContainerPrecision>;
	ANALYSIS_MODEL_ID: "analysis-model-staging-v1";
	ANALYSIS_ENGINE_ID: "YaneuraOu NNUE 9.70git 64AVX2";
	ANALYSIS_ENGINE_BINARY_DIGEST_LABEL: "sha256:0cb27c8302f6eb357cd360372defe172401519c06fb4bf28eb2bf72ee0f39d80";
	ANALYSIS_ADMIN_TOKEN?: string;
	STAGING_ADMIN_TOKEN?: string;
	ANALYSIS_FAULT_FIXTURES_ENABLED?: string;
}
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("./src/index");
		durableNamespaces: "AnalysisContainer" | "AnalysisContainerPrecision" | "JobCoordinator";
	}
	interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}
