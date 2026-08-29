package backup

const (
	defaultRemote = "https://github.com/steipete/backup-gog.git"
)

type Config struct {
	Repo       string   `json:"repo"`
	Remote     string   `json:"remote"`
	Identity   string   `json:"identity"`
	Recipients []string `json:"recipients"`
}

type Options struct {
	ConfigStore           *ConfigStore
	ConfigPath            string
	Repo                  string
	Remote                string
	Identity              string
	Recipients            []string
	SuppressDefaultRemote bool
	Push                  bool
	SkipPull              bool
	AsyncPush             bool
	PushQueueLimit        int
	Progress              func(format string, args ...any)
}

func DefaultConfig() Config {
	return Config{
		Repo:     "~/Projects/backup-gog",
		Remote:   defaultRemote,
		Identity: "~/.gog/age.key",
	}
}
