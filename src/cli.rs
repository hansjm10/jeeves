use clap::{Parser, Subcommand};

/// Jeeves - Agent orchestration system
#[derive(Parser, Debug)]
#[command(name = "jeeves")]
#[command(about = "Agent orchestration system for automated development workflows")]
#[command(version)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug, PartialEq)]
pub enum Commands {
    /// Initialize a new issue workspace
    Init {
        /// GitHub issue number
        #[arg(long)]
        issue: u32,

        /// Repository in owner/repo format
        #[arg(long)]
        repo: String,
    },

    /// Run the orchestration loop
    Run {
        /// Maximum number of iterations
        #[arg(long, default_value = "10")]
        max_iterations: u32,

        /// Runner to use (claude, codex, opencode)
        #[arg(long, default_value = "opencode")]
        runner: String,
    },

    /// Fetch SonarCloud issues
    Sonar,

    /// Generate a design document
    DesignDoc,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn test_init_subcommand() {
        let cli = Cli::parse_from(["jeeves", "init", "--issue", "42", "--repo", "owner/repo"]);
        match cli.command {
            Commands::Init { issue, repo } => {
                assert_eq!(issue, 42);
                assert_eq!(repo, "owner/repo");
            }
            _ => panic!("Expected Init command"),
        }
    }

    #[test]
    fn test_run_subcommand_defaults() {
        let cli = Cli::parse_from(["jeeves", "run"]);
        match cli.command {
            Commands::Run {
                max_iterations,
                runner,
            } => {
                assert_eq!(max_iterations, 10);
                assert_eq!(runner, "opencode");
            }
            _ => panic!("Expected Run command"),
        }
    }

    #[test]
    fn test_run_subcommand_with_args() {
        let cli = Cli::parse_from([
            "jeeves",
            "run",
            "--max-iterations",
            "20",
            "--runner",
            "claude",
        ]);
        match cli.command {
            Commands::Run {
                max_iterations,
                runner,
            } => {
                assert_eq!(max_iterations, 20);
                assert_eq!(runner, "claude");
            }
            _ => panic!("Expected Run command"),
        }
    }

    #[test]
    fn test_sonar_subcommand() {
        let cli = Cli::parse_from(["jeeves", "sonar"]);
        assert!(matches!(cli.command, Commands::Sonar));
    }

    #[test]
    fn test_design_doc_subcommand() {
        let cli = Cli::parse_from(["jeeves", "design-doc"]);
        assert!(matches!(cli.command, Commands::DesignDoc));
    }

    #[test]
    fn test_help_does_not_panic() {
        // Verify help doesn't panic (it will exit with error, but shouldn't panic)
        let result = Cli::try_parse_from(["jeeves", "--help"]);
        assert!(result.is_err()); // --help causes early exit which is an "error"
    }
}
