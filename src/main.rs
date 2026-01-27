mod cli;

use clap::Parser;
use cli::{Cli, Commands};

fn main() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Init { issue, repo } => {
            println!("Initializing issue #{issue} for {repo}");
            // TODO: Implement init logic in T7
        }
        Commands::Run {
            max_iterations,
            runner,
        } => {
            println!("Running orchestrator with {runner} for max {max_iterations} iterations");
            // TODO: Implement run logic in T4
        }
        Commands::Sonar => {
            println!("Fetching SonarCloud issues");
            // TODO: Implement sonar logic
        }
        Commands::DesignDoc => {
            println!("Generating design document");
            // TODO: Implement design-doc logic
        }
    }
}
