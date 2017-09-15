'use strict';


/*@ngInject*/
function AttributeSaveToLibrary(config) {
  return {
    restrict: 'E',
    templateUrl: 'app/common/deepsense-components/deepsense-attributes-panel/attribute-types/attribute-save-to-library/attribute-save-to-library-type.html',
    replace: true,
    link: function (scope) {
      scope.placeInLibrary = scope.parameter.value && scope.parameter.value.indexOf(config.libraryPrefix) === 0;
      scope.file = {
        name: getNameFromURI(scope.parameter.value),
        uri: scope.parameter.value
      };

      scope.$watchGroup(['file.name', 'placeInLibrary'], () => {
        scope.file.uri = addURIToName(scope.file.name);
        if (scope.placeInLibrary) {
          scope.parameter.value = scope.file.uri;
        } else {
          scope.parameter.value = scope.file.name;
        }
      });

      function getNameFromURI(uri) {
        return uri ? uri.replace(config.libraryPrefix, '') : '';
      }

      function addURIToName(name) {
        return config.libraryPrefix + name;
      }
    }
  };
}

angular.module('deepsense.attributes-panel')
  .directive('attributeSaveToLibrary', AttributeSaveToLibrary);
