#import <UIKit/UIKit.h>

@interface MeeshogiFixtureAppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation MeeshogiFixtureAppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary<UIApplicationLaunchOptionsKey, id> *)launchOptions {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  UIViewController *controller = [[UIViewController alloc] init];
  controller.view.backgroundColor = UIColor.systemBackgroundColor;
  self.window.rootViewController = controller;
  [self.window makeKeyAndVisible];
  return YES;
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(MeeshogiFixtureAppDelegate.class));
  }
}
